//! sandbox-access 的字节流连接模块。
//!
//! 负责按 [`EndpointDesc`] 连接沙箱内服务（SSH、SFTP、ACP、原生 TCP 服务），
//! 依端点模式选择直连 TCP 或 Gateway TCP-over-WebSocket 隧道，并在连接上承载
//! 相同的上层协议。本 crate 只管理本地连接与传输，对端会话资源由 session-service
//! 与各服务自身管理。
//!
//! # 模块组成
//!
//! - [`error`]：[`ChannelError`]，区分鉴权失败、不可达、隧道禁用、协议错误、
//!   已关闭与 IO 故障等变体，供调用方可区分处理。
//! - [`endpoint`]：[`EndpointDesc`] 端点描述与传输模式（直连/隧道）。
//! - [`transport`]：底层字节流抽象 [`transport::BoxStream`]，直连 TCP 与
//!   TCP-over-WebSocket 隧道统一呈现为 `AsyncRead + AsyncWrite`。
//! - [`observer`]：[`observer::ChannelObserver`] 可选观测接入口（命令结果、
//!   连接状态、字节计数），无消费者时零开销。
//! - [`conn`]：[`conn::SandboxConnection`] 连接句柄（显式关闭、drop 回收）。
//! - [`ssh`]：基于 russh 的 SSH 命令执行与鉴权（密码/私钥）。
//! - [`sftp`]：基于 russh-sftp 的文件读写（put/get，分块传输）。
//! - [`acp`]：[`acp::AcpTransport`]，在连接字节流上承载 ACP JSON 消息。
//! - [`env`]：[`env::ChannelEnv`]，把 SSH exec 与 SFTP 适配为
//!   `flow_core::domain::ExecutionEnv`。
//!
//! # 隧道协议（TCP over WebSocket，ursi-tcp-v1）
//!
//! 与 Gateway `GET /api/v1/sandboxes/{id}/connect/{endpoint}` 对接，细节见
//! Gateway 公开传输契约的「可选 TCP over WebSocket」：
//!
//! - WebSocket 子协议 `ursi-tcp-v1`，`Authorization: Bearer <token>` 鉴权；
//!   携带 Origin 或任何 query 参数会被拒绝。
//! - 二进制消息承载有序 TCP 字节，客户端每消息最多 64 KiB（Gateway 输出每块
//!   最多 32 KiB）；文本 `eof` 表示该方向半关闭，对端可继续发送尾包；
//!   其他文本、EOF 后继续数据均导致连接关闭。
//! - Ping/Pong 保活；隧道自身不重试任何上层请求。
//!
//! 隧道流在实现上直接复用 tokio-tungstenite 的 WebSocketStream：
//! `poll_read` 跳过控制帧，`poll_write` 按 64 KiB 上限分块发送二进制消息，
//! `poll_shutdown` 发送文本 `eof` 并等待对端关闭。
//!
//! # 内部 ACP 帧协议（非 Runtime `/acp` WebSocket）
//!
//! ACP 消息为一段 UTF-8 JSON 文本，帧格式为「4 字节大端无符号长度 + JSON 字节」，
//! 长度不含帧头本身，单帧上限 1 MiB。消息按帧序严格保序；`id` 字段由调用方
//! 提供并原样回传，用于请求关联（见 [`acp`] 模块文档）。

pub mod acp;
pub mod conn;
pub mod endpoint;
pub mod env;
pub mod error;
pub mod observer;
pub mod sftp;
pub mod ssh;
pub mod transport;

pub use conn::SandboxConnection;
pub use endpoint::{AuthMethod, EndpointDesc, EndpointMode};
pub use env::ChannelEnv;
pub use error::ChannelError;
pub use observer::{ByteCounters, ChannelObserver, CommandResult, ConnectionState, NoopObserver};

use std::sync::Arc;

/// 连接库入口：按端点描述建立 [`SandboxConnection`]。
///
/// [`SandboxConnection`] 是传输层句柄，承载任意字节流服务；SSH/SFTP/ACP
/// 等协议接入在句柄之上按需展开（[`ssh`]、[`sftp`]、[`acp`]）。
#[derive(Debug, Default, Clone)]
pub struct Channel;

impl Channel {
    /// 按端点描述连接沙箱内服务。
    ///
    /// 直连模式发起 TCP 连接；隧道模式按 Gateway 契约升级 WebSocket
    /// （`ursi-tcp-v1`）。`observer` 为可选观测消费者，传 `None` 时
    /// 不影响任何功能。
    pub async fn connect(
        desc: EndpointDesc,
        observer: Option<Arc<dyn ChannelObserver>>,
    ) -> Result<SandboxConnection, ChannelError> {
        let stream = transport::open_stream(&desc).await?;
        Ok(SandboxConnection::new(desc, stream, observer))
    }
}
