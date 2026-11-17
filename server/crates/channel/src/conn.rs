//! 连接句柄：[`SandboxConnection`]。
//!
//! 句柄拥有底层字节流，提供原始字节收发（供 HTTP/WebSocket 代理等原生协议
//! 使用）、显式关闭与状态查询。drop 时静默回收本地资源（关闭 TCP/WebSocket
//! 连接），不会 panic；显式 [`SandboxConnection::close`] 后再使用返回
//! [`ChannelError::Closed`]。
//!
//! 连接故障语义：对端主动断开或协议违规时，后续读写返回
//! [`ChannelError::Io`] / [`ChannelError::Protocol`]，本 crate 不自动重连，
//! 也不重试任何上层请求；上层据此报告故障。

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use crate::endpoint::EndpointDesc;
use crate::error::ChannelError;
use crate::observer::{ConnectionState, ObserverHandle};
use crate::transport::BoxStream;

/// 沙箱连接句柄。
pub struct SandboxConnection {
    desc: EndpointDesc,
    stream: Option<BoxStream>,
    observer: ObserverHandle,
    /// 关闭原因，供 close 后复用时报错诊断。
    closed_reason: Arc<std::sync::Mutex<Option<String>>>,
}

impl std::fmt::Debug for SandboxConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SandboxConnection")
            .field("sandbox_id", &self.desc.sandbox_id)
            .field("endpoint", &self.desc.endpoint_name)
            .field("open", &self.stream.is_some())
            .finish()
    }
}

impl SandboxConnection {
    /// 由 [`crate::Channel::connect`] 构造。
    pub(crate) fn new(
        desc: EndpointDesc,
        stream: BoxStream,
        observer: Option<Arc<dyn crate::observer::ChannelObserver>>,
    ) -> Self {
        let handle = ObserverHandle::new(observer);
        handle.connection_state(ConnectionState::Connected);
        Self {
            desc,
            stream: Some(stream),
            observer: handle,
            closed_reason: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    /// 端点描述。
    pub fn desc(&self) -> &EndpointDesc {
        &self.desc
    }

    /// 连接是否仍打开。
    pub fn is_open(&self) -> bool {
        self.stream.is_some()
    }

    /// 发送字节。
    pub async fn send(&mut self, data: &[u8]) -> Result<(), ChannelError> {
        if self.stream.is_none() {
            return Err(self.closed_error());
        }
        let stream = self.stream.as_mut().expect("已检查 Some");
        stream
            .write_all(data)
            .await
            .map_err(io_err)?;
        stream
            .flush()
            .await
            .map_err(io_err)?;
        self.observer.bytes_tx(data.len());
        Ok(())
    }

    /// 接收字节，读到任意可用数据即返回；对端半关闭返回 `Ok(0)`。
    pub async fn recv(&mut self, buf: &mut [u8]) -> Result<usize, ChannelError> {
        if self.stream.is_none() {
            return Err(self.closed_error());
        }
        let stream = self.stream.as_mut().expect("已检查 Some");
        let n = stream.read(buf).await.map_err(io_err)?;
        self.observer.bytes_rx(n);
        Ok(n)
    }

    /// 半关闭写方向（TCP FIN / 隧道 `eof` 文本）。
    pub async fn shutdown_write(&mut self) -> Result<(), ChannelError> {
        if self.stream.is_none() {
            return Err(self.closed_error());
        }
        let stream = self.stream.as_mut().expect("已检查 Some");
        stream
            .shutdown()
            .await
            .map_err(io_err)?;
        Ok(())
    }

    /// 显式关闭连接并回收本地资源。重复调用无副作用。
    pub async fn close(&mut self) -> Result<(), ChannelError> {
        if let Some(mut stream) = self.stream.take() {
            self.observer.connection_state(ConnectionState::Closed);
            *self.closed_reason.lock().unwrap() = Some("显式关闭".into());
            // 尽力半关闭，忽略对端已断开的情况。
            let _ = stream.shutdown().await;
        }
        Ok(())
    }

    /// 消费内部流（连接转交协议模块时使用）。
    pub fn take_stream(&mut self) -> Result<BoxStream, ChannelError> {
        self.stream.take().ok_or_else(|| self.closed_error())
    }

    fn closed_error(&self) -> ChannelError {
        let _reason = self
            .closed_reason
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "连接已关闭".into());
        ChannelError::Closed
    }

    /// 关闭原因（诊断用）。
    pub fn closed_reason(&self) -> Option<String> {
        self.closed_reason.lock().unwrap().clone()
    }
}

/// 把 IO 错误还原为 ChannelError（隧道错误在构造时已包入 io::Error）。
fn io_err(e: std::io::Error) -> ChannelError {
    let msg = e.to_string();
    match e.into_inner() {
        Some(ce) => match ce.downcast::<ChannelError>() {
            Ok(channel_err) => *channel_err,
            Err(other) => ChannelError::Io(other.to_string()),
        },
        None => ChannelError::Io(msg),
    }
}

impl Drop for SandboxConnection {
    /// drop 时静默回收本地资源（TCP/WebSocket 连接随之关闭），不 panic。
    fn drop(&mut self) {
        if self.stream.take().is_some() {
            self.observer.connection_state(ConnectionState::Closed);
        }
    }
}

