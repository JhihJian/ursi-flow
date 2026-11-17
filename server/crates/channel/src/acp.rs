//! ACP 消息传输：在 Channel 连接字节流上承载 JSON 消息。
//!
//! # 帧协议（自定，联合验收前为本项目内部协议）
//!
//! - 每条 ACP 消息是一段 UTF-8 JSON 文本（对象）。
//! - 帧格式：`4 字节大端无符号长度 + JSON 字节`，长度不含帧头本身，
//!   单帧载荷上限 [`ACP_MAX_FRAME`]（1 MiB）。
//! - 消息按帧序严格保序；同一连接上双向各自独立保序。
//! - 消息关联：JSON 对象中的 `id` 字段由调用方提供并原样回传，用于
//!   请求/响应关联；本传输层不解释消息内容，只保证字节完整与顺序。
//! - 写方向半关闭（`shutdown_write`）后对端读到 EOF；本层不重试。
//!
//! 真实 ACP 对接是 session-service（联合验收）；测试用进程内 echo ACP
//! server 验证帧编解码与往返。

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::ChannelError;

/// 单帧载荷上限：1 MiB。
pub const ACP_MAX_FRAME: usize = 1024 * 1024;
/// 帧头长度：4 字节大端。
pub const ACP_HEADER_LEN: usize = 4;

/// ACP 传输 trait：在连接字节流上收发 JSON 消息。
///
/// 实现方保证消息顺序与完整性；`id` 由消息内容自带，传输层不解释。
pub trait AcpTransport: Send {
    /// 发送一条 JSON 消息（整帧原子写入）。
    fn send_message(
        &mut self,
        message: &Value,
    ) -> impl std::future::Future<Output = Result<(), ChannelError>> + Send;

    /// 接收下一条 JSON 消息（阻塞直到完整帧到达）。
    fn recv_message(
        &mut self,
    ) -> impl std::future::Future<Output = Result<Value, ChannelError>> + Send;
}

/// 帧编码：4 字节大端长度 + JSON 字节。
pub fn encode_frame(message: &Value) -> Result<Vec<u8>, ChannelError> {
    let payload = serde_json::to_vec(message)
        .map_err(|e| ChannelError::Protocol(format!("ACP 消息序列化失败：{e}")))?;
    if payload.len() > ACP_MAX_FRAME {
        return Err(ChannelError::Protocol(format!(
            "ACP 消息超长：{} > {ACP_MAX_FRAME}",
            payload.len()
        )));
    }
    let mut frame = Vec::with_capacity(ACP_HEADER_LEN + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

/// 帧解码：从缓冲读取一帧；数据不足返回 `Ok(None)`。
pub fn decode_frame(buf: &mut bytes::BytesMut) -> Result<Option<Value>, ChannelError> {
    if buf.len() < ACP_HEADER_LEN {
        return Ok(None);
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len > ACP_MAX_FRAME {
        return Err(ChannelError::Protocol(format!(
            "ACP 帧越界：{len} > {ACP_MAX_FRAME}"
        )));
    }
    if buf.len() < ACP_HEADER_LEN + len {
        return Ok(None);
    }
    let payload = buf.split_to(ACP_HEADER_LEN + len).split_off(ACP_HEADER_LEN);
    let msg: Value = serde_json::from_slice(&payload)
        .map_err(|e| ChannelError::Protocol(format!("ACP 消息反序列化失败：{e}")))?;
    Ok(Some(msg))
}

/// 在任意字节流上运行的 ACP 传输实现。
pub struct StreamAcp<S> {
    stream: S,
    read_buf: bytes::BytesMut,
}

impl<S> StreamAcp<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    /// 包装一条字节流。
    pub fn new(stream: S) -> Self {
        Self {
            stream,
            read_buf: bytes::BytesMut::with_capacity(4096),
        }
    }

    /// 解包归还底层流。
    pub fn into_inner(self) -> S {
        self.stream
    }
}

impl<S> AcpTransport for StreamAcp<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    async fn send_message(&mut self, message: &Value) -> Result<(), ChannelError> {
        let frame = encode_frame(message)?;
        self.stream
            .write_all(&frame)
            .await
            .map_err(|e| ChannelError::Io(format!("ACP 发送失败：{e}")))?;
        self.stream
            .flush()
            .await
            .map_err(|e| ChannelError::Io(format!("ACP flush 失败：{e}")))?;
        Ok(())
    }

    async fn recv_message(&mut self) -> Result<Value, ChannelError> {
        loop {
            if let Some(msg) = decode_frame(&mut self.read_buf)? {
                return Ok(msg);
            }
            let mut chunk = [0u8; 8192];
            let n = self
                .stream
                .read(&mut chunk)
                .await
                .map_err(|e| ChannelError::Io(format!("ACP 接收失败：{e}")))?;
            if n == 0 {
                // 对端半关闭：缓冲中还有完整帧则先交付，否则报告断开。
                if let Some(msg) = decode_frame(&mut self.read_buf)? {
                    return Ok(msg);
                }
                return Err(ChannelError::Io("ACP 连接已断开".into()));
            }
            self.read_buf.extend_from_slice(&chunk[..n]);
        }
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    #[test]
    fn 帧编码含大端长度头() {
        let msg = serde_json::json!({"id": 1, "method": "session/prompt"});
        let frame = encode_frame(&msg).unwrap();
        let len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
        assert_eq!(frame.len(), ACP_HEADER_LEN + len);
        assert_eq!(&frame[4..], serde_json::to_vec(&msg).unwrap().as_slice());
    }

    #[test]
    fn 帧超长被拒绝() {
        let msg = serde_json::json!({"pad": "x".repeat(ACP_MAX_FRAME + 10)});
        let err = encode_frame(&msg).unwrap_err();
        assert!(matches!(err, ChannelError::Protocol(_)));
    }

    #[test]
    fn 分片到达也能完整解码() {
        let msg = serde_json::json!({"id": 7, "result": "ok"});
        let frame = encode_frame(&msg).unwrap();
        let mut buf = bytes::BytesMut::new();

        // 一次只给 1 字节，逐步喂入。
        for piece in frame.clone() {
            buf.extend_from_slice(&[piece]);
            match decode_frame(&mut buf).unwrap() {
                None => continue,
                Some(v) => {
                    assert_eq!(v, msg);
                    return;
                }
            }
        }
        panic!("分片喂完后仍未解出帧");
    }

    #[test]
    fn 多帧顺序解码() {
        let m1 = serde_json::json!({"id": 1});
        let m2 = serde_json::json!({"id": 2});
        let mut buf = bytes::BytesMut::new();
        buf.extend_from_slice(&encode_frame(&m1).unwrap());
        buf.extend_from_slice(&encode_frame(&m2).unwrap());
        assert_eq!(decode_frame(&mut buf).unwrap().unwrap(), m1);
        assert_eq!(decode_frame(&mut buf).unwrap().unwrap(), m2);
        assert!(decode_frame(&mut buf).unwrap().is_none());
    }

    #[test]
    fn 越界帧头返回协议错误() {
        let mut buf = bytes::BytesMut::new();
        buf.extend_from_slice(&(ACP_MAX_FRAME as u32 + 1).to_be_bytes());
        let err = decode_frame(&mut buf).unwrap_err();
        assert!(matches!(err, ChannelError::Protocol(_)));
    }

    #[tokio::test]
    async fn echo服务器上消息按序往返() {
        use tokio::io::duplex;

        // 内存 duplex：一半给 echo server，一半给客户端。
        let (client_side, server_side) = duplex(64 * 1024);
        let server = StreamAcp::new(server_side);

        // echo 任务：原样回发每条消息。
        tokio::spawn(async move {
            let mut echo = StreamAcp::new(client_side);
            while let Ok(msg) = echo.recv_message().await {
                if echo.send_message(&msg).await.is_err() {
                    break;
                }
            }
        });

        let mut client = StreamAcp::new(server.into_inner());
        let sent: Vec<Value> = (0..5)
            .map(|i| serde_json::json!({"id": i, "method": "session/prompt", "p": i * 100}))
            .collect();
        for m in &sent {
            client.send_message(m).await.unwrap();
        }
        for m in &sent {
            let got = client.recv_message().await.unwrap();
            assert_eq!(got, *m, "顺序或内容被破坏");
        }
    }

    #[tokio::test]
    async fn 对端断开后报IO错误() {
        use tokio::io::duplex;
        let (a, b) = duplex(1024);
        drop(a); // 立即断开
        let mut client = StreamAcp::new(b);
        let err = client.recv_message().await.unwrap_err();
        assert!(matches!(err, ChannelError::Io(_)), "{err}");
    }
}
