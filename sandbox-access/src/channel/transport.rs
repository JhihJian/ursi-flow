//! 底层字节流传输：直连 TCP 与 TCP-over-WebSocket 隧道统一为
//! `AsyncRead + AsyncWrite`。
//!
//! # 隧道协议（ursi-tcp-v1，与 Gateway 契约一致）
//!
//! - `GET /api/v1/sandboxes/{sandbox_id}/connect/{endpoint_name}`，升级为
//!   WebSocket，子协议 `ursi-tcp-v1`，`Authorization: Bearer <token>`。
//!   携带 Origin 或任何 query 参数会被 Gateway 拒绝，因此两者都不发送。
//! - 二进制消息承载有序 TCP 字节；客户端每消息最多 64 KiB（[`TUNNEL_MAX_CHUNK`]）。
//! - 文本 `eof` 表示该方向半关闭，另一方向可继续传尾包；重复 EOF、EOF 后
//!   继续数据、其他文本都会关闭连接。
//! - Ping/Pong 由底层 WebSocket 栈自动回应；空闲 75 秒、写入停滞 30 秒后
//!   Gateway 可终止连接。
//! - 隧道自身不重试任何上层请求。
//!
//! 直连与隧道对上层呈现同一条字节流，同一套协议（SSH/SFTP/ACP/HTTP）在两种
//! 模式下的行为一致。

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use futures_util::stream::Stream as _;
use futures_util::sink::Sink as _;

use crate::channel::endpoint::{EndpointDesc, EndpointMode};
use crate::channel::error::ChannelError;

/// 客户端单条 WebSocket 二进制消息的字节上限（64 KiB）。
pub const TUNNEL_MAX_CHUNK: usize = 64 * 1024;
/// 半关闭语义文本（该方向不再发送数据）。
pub const TUNNEL_EOF_TEXT: &str = "eof";
/// WebSocket 子协议名。
pub const TUNNEL_SUBPROTOCOL: &str = "ursi-tcp-v1";

/// 统一底层流类型。
pub type BoxStream = Pin<Box<dyn AsyncStream>>;

/// 双向异步字节流别名。
pub trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncStream for T {}

/// 建立端点字节流。
///
/// 直连模式直接 TCP connect；隧道模式完成 WebSocket 升级（升级前失败按
/// HTTP 状态映射为可区分错误）。
pub async fn open_stream(desc: &EndpointDesc) -> Result<BoxStream, ChannelError> {
    match &desc.mode {
        EndpointMode::Direct => {
            let addr = (desc.host.as_str(), desc.port);
            let tcp = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                tokio::net::TcpStream::connect(addr),
            )
            .await
            .map_err(|_| ChannelError::Unreachable(format!("连接超时：{}:{}", desc.host, desc.port)))?
            .map_err(|e| ChannelError::Unreachable(format!("{}:{}：{e}", desc.host, desc.port)))?;
            tcp.set_nodelay(true).ok();
            Ok(Box::pin(tcp))
        }
        EndpointMode::Tunnel {
            gateway_ws_url,
            bearer_token,
        } => {
            let stream = open_tunnel(desc, gateway_ws_url, bearer_token).await?;
            Ok(Box::pin(stream))
        }
    }
}

/// 建立 TCP-over-WebSocket 隧道流。
async fn open_tunnel(
    desc: &EndpointDesc,
    gateway_ws_url: &str,
    bearer_token: &str,
) -> Result<TunnelStream, ChannelError> {
    let base = gateway_ws_url.trim_end_matches('/');
    let url = format!(
        "{base}/api/v1/sandboxes/{}/connect/{}",
        desc.sandbox_id, desc.endpoint_name
    );
    let mut request = url
        .into_client_request()
        .map_err(|e| ChannelError::Protocol(format!("隧道 URL 非法：{e}")))?;
    // 契约要求：Bearer 鉴权放 header，拒绝 Origin 与 query 参数，均不发送。
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {bearer_token}"))
            .map_err(|_| ChannelError::Protocol("Bearer 凭据含非法字符".into()))?,
    );
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static(TUNNEL_SUBPROTOCOL),
    );

    let (ws, response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(map_tunnel_connect_error)?;
    // tokio-tungstenite 会自动校验子协议与升级应答；此处再确认一次。
    if let Some(resp_proto) = response.headers().get("Sec-WebSocket-Protocol") {
        if resp_proto != TUNNEL_SUBPROTOCOL {
            return Err(ChannelError::Protocol(format!(
                "子协议不匹配：{resp_proto:?}"
            )));
        }
    }
    Ok(TunnelStream::new(ws))
}

/// 把隧道升级失败映射为可区分错误。
fn map_tunnel_connect_error(err: tokio_tungstenite::tungstenite::Error) -> ChannelError {
    use tokio_tungstenite::tungstenite::error::ProtocolError;
    match &err {
        tokio_tungstenite::tungstenite::Error::Http(resp) => {
            let code = resp.status().as_u16();
            let body = resp
                .body()
                .as_ref()
                .map(|chunks| {
                    chunks
                        .iter()
                        .map(|b| String::from_utf8_lossy(std::slice::from_ref(b)).into_owned())
                        .collect::<String>()
                })
                .unwrap_or_default();
            match code {
                401 => ChannelError::AuthFailed(format!("Gateway 401：{body}")),
                501 => ChannelError::TunnelDisabled,
                502 => ChannelError::Unreachable(format!("隧道目标不可达（502）：{body}")),
                503 => ChannelError::Unreachable(format!("资源暂不可用（503）：{body}")),
                _ => ChannelError::Unreachable(format!("隧道升级失败 HTTP {code}：{body}")),
            }
        }
        tokio_tungstenite::tungstenite::Error::Protocol(
            ProtocolError::WrongHttpVersion
            | ProtocolError::MissingUpgradeWebSocketHeader
            | ProtocolError::MissingConnectionUpgradeHeader,
        ) => ChannelError::Protocol(format!("目标非 WebSocket 端点：{err}")),
        _ => ChannelError::Unreachable(format!("隧道连接失败：{err}")),
    }
}

/// TCP-over-WebSocket 隧道流：把 WebSocket 消息流呈现为字节流。
///
/// 读方向跳过 Ping/Pong 等控制帧，把二进制消息字节顺序交付，文本 `eof`
/// 视为本方向读结束；写方向按 [`TUNNEL_MAX_CHUNK`] 分块发送二进制消息，
/// `shutdown` 发送文本 `eof`（半关闭）并等待对端关闭帧。
pub struct TunnelStream {
    inner: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    /// 读缓冲：当前半消费的二进制消息。
    read_buf: bytes::BytesMut,
    /// 读方向已结束（收到 `eof` 或连接关闭）。
    read_eof: bool,
    /// 写方向已发送 `eof`。
    write_eof: bool,
}

impl TunnelStream {
    fn new(
        inner: tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> Self {
        Self {
            inner,
            read_buf: bytes::BytesMut::new(),
            read_eof: false,
            write_eof: false,
        }
    }

    /// 从 WebSocket 拉取下一段二进制数据到内部缓冲。
    fn pull_next(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        loop {
            match Pin::new(&mut self.inner).poll_next(cx) {
                Poll::Ready(Some(Ok(msg))) => match msg {
                    Message::Binary(data) => {
                        self.read_buf.extend_from_slice(&data);
                        return Poll::Ready(Ok(()));
                    }
                    Message::Text(text) => {
                        if text == TUNNEL_EOF_TEXT {
                            // 对端不再发送数据：本方向读结束。
                            self.read_eof = true;
                            return Poll::Ready(Ok(()));
                        }
                        // 契约规定其他文本一律关闭连接。
                        return Poll::Ready(Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            ChannelError::Protocol(format!("隧道收到非法文本帧：{text}")),
                        )));
                    }
                    Message::Close(frame) => {
                        self.read_eof = true;
                        self.write_eof = true;
                        let reason = frame
                            .map(|f| f.reason.to_string())
                            .unwrap_or_else(|| "对端关闭".into());
                        return Poll::Ready(Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            ChannelError::Io(format!("隧道被对端关闭：{reason}")),
                        )));
                    }
                    // Ping 自动回 Pong；Pong 忽略。继续拉取下一帧。
                    Message::Ping(_) | Message::Pong(_) => continue,
                    Message::Frame(_) => continue,
                },
                Poll::Ready(Some(Err(e))) => {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        ChannelError::Io(format!("隧道断开：{e}")),
                    )));
                }
                Poll::Ready(None) => {
                    self.read_eof = true;
                    self.write_eof = true;
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        ChannelError::Io("隧道已断开".into()),
                    )));
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

impl AsyncRead for TunnelStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.read_eof && this.read_buf.is_empty() {
            // 读方向半关闭：表现为持续 EOF。
            return Poll::Ready(Ok(()));
        }
        if !this.read_buf.is_empty() {
            let n = this.read_buf.len().min(buf.remaining());
            let data = this.read_buf.split_to(n);
            buf.put_slice(&data);
            return Poll::Ready(Ok(()));
        }
        match this.pull_next(cx) {
            Poll::Ready(Ok(())) => {
                if this.read_buf.is_empty() {
                    // 收到 eof 文本且无尾包：EOF。
                    return Poll::Ready(Ok(()));
                }
                let n = this.read_buf.len().min(buf.remaining());
                let data = this.read_buf.split_to(n);
                buf.put_slice(&data);
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl AsyncWrite for TunnelStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.write_eof {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                ChannelError::Closed,
            )));
        }
        // 契约上限：客户端每消息最多 64 KiB。
        let n = buf.len().min(TUNNEL_MAX_CHUNK);
        let chunk = &buf[..n];
        match Pin::new(&mut this.inner).poll_ready(cx) {
            Poll::Ready(Ok(())) => {
                let msg = Message::Binary(chunk.to_vec().into());
                if let Err(e) = Pin::new(&mut this.inner).start_send(msg) {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        ChannelError::Io(format!("隧道发送失败：{e}")),
                    )));
                }
                match Pin::new(&mut this.inner).poll_flush(cx) {
                    Poll::Ready(Ok(())) => Poll::Ready(Ok(n)),
                    Poll::Ready(Err(e)) => Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        ChannelError::Io(format!("隧道发送失败：{e}")),
                    ))),
                    Poll::Pending => Poll::Pending,
                }
            }
            Poll::Ready(Err(e)) => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                ChannelError::Io(format!("隧道发送失败：{e}")),
            ))),
            Poll::Pending => Poll::Pending,
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner)
            .poll_flush(cx)
            .map_err(|e| {
                io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    ChannelError::Io(format!("隧道 flush 失败：{e}")),
                )
            })
    }

    /// 半关闭写方向：发送文本 `eof`，随后继续读尾包直至对端关闭。
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if !this.write_eof {
            match Pin::new(&mut this.inner).poll_ready(cx) {
                Poll::Ready(Ok(())) => {
                    if let Err(e) =
                        Pin::new(&mut this.inner).start_send(Message::Text(TUNNEL_EOF_TEXT.into()))
                    {
                        return Poll::Ready(Err(io::Error::new(
                            io::ErrorKind::BrokenPipe,
                            ChannelError::Io(format!("隧道发送 eof 失败：{e}")),
                        )));
                    }
                    this.write_eof = true;
                }
                Poll::Ready(Err(e)) => {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        ChannelError::Io(format!("隧道发送 eof 失败：{e}")),
                    )))
                }
                Poll::Pending => return Poll::Pending,
            }
        }
        Pin::new(&mut this.inner)
            .poll_flush(cx)
            .map_err(|e| {
                io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    ChannelError::Io(format!("隧道 flush 失败：{e}")),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::endpoint::EndpointMode;

    #[test]
    fn 隧道分块上限为64kib() {
        assert_eq!(TUNNEL_MAX_CHUNK, 65536);
    }

    #[test]
    fn 端点描述构造正确() {
        let d = EndpointDesc::tunnel("sb-1", "ssh", "ws://g:8080", "tok");
        assert_eq!(d.sandbox_id, "sb-1");
        assert!(matches!(d.mode, EndpointMode::Tunnel { .. }));
        let d2 = EndpointDesc::direct("127.0.0.1", 22);
        assert_eq!(d2.port, 22);
    }

    #[test]
    fn 错误变体可区分() {
        let e1 = ChannelError::TunnelDisabled;
        assert!(!e1.is_connection_broken());
        let e2 = ChannelError::Io("断开".into());
        assert!(e2.is_connection_broken());
        let e3 = ChannelError::Closed;
        assert!(!e3.is_connection_broken());
    }

    #[test]
    fn 隧道升级错误映射() {
        use tokio_tungstenite::tungstenite::http::Response;
        let resp: Response<Option<Vec<u8>>> = Response::builder().status(401).body(None).unwrap();
        let e = map_tunnel_connect_error(tokio_tungstenite::tungstenite::Error::Http(Box::new(resp)));
        assert!(matches!(e, ChannelError::AuthFailed(_)));

        let resp: Response<Option<Vec<u8>>> = Response::builder().status(501).body(None).unwrap();
        let e = map_tunnel_connect_error(tokio_tungstenite::tungstenite::Error::Http(Box::new(resp)));
        assert!(matches!(e, ChannelError::TunnelDisabled));

        let resp: Response<Option<Vec<u8>>> = Response::builder().status(502).body(None).unwrap();
        let e = map_tunnel_connect_error(tokio_tungstenite::tungstenite::Error::Http(Box::new(resp)));
        assert!(matches!(e, ChannelError::Unreachable(_)));
    }
}
