//! 连接错误定义。
//!
//! 错误变体按调用方可采取的动作划分：鉴权失败（凭据错误）、不可达（网络层
//! 失败）、隧道禁用（Gateway 能力缺失）、协议错误（隧道/帧协议违规）、已关闭
//! （本地连接已回收）与 IO 故障。网络断开统一落到 [`ChannelError::Io`]，
//! 本 crate 不自动重连，也不重试任何上层请求。

use thiserror::Error;

/// Channel 各环节错误。
#[derive(Debug, Error)]
pub enum ChannelError {
    /// 端点鉴权失败（密码或公钥被对端拒绝、Bearer 无效导致 HTTP 401）。
    #[error("鉴权失败：{0}")]
    AuthFailed(String),

    /// 端点不可达（连接被拒绝、超时、DNS 失败、隧道升级前失败等）。
    #[error("端点不可达：{0}")]
    Unreachable(String),

    /// 隧道被禁用（Gateway 返回 501）。
    #[error("隧道已禁用")]
    TunnelDisabled,

    /// 协议违规（WebSocket 帧违规、非预期文本、ACP 帧越界等）。
    #[error("协议错误：{0}")]
    Protocol(String),

    /// 连接已显式关闭或已断开回收，禁止继续使用。
    #[error("连接已关闭")]
    Closed,

    /// 网络读写故障（含连接中途断开），不自动重连。
    #[error("IO 故障：{0}")]
    Io(String),
}

impl ChannelError {
    /// 判断是否为连接故障（网络断开或协议中断），调用方据此报告故障而非重试。
    pub fn is_connection_broken(&self) -> bool {
        matches!(self, ChannelError::Io(_) | ChannelError::Protocol(_))
    }
}
