//! 文件与命令通道网关窄接口。
//!
//! 对应 SPEC「文件与连接接入」：输入文件传输、脚本命令执行与获准
//! 端点访问。`open_*` 只负责建立通道句柄并接收目标身份；会话控制
//! 归 Agent Runtime，本接口不重试、不自动重连。
//!
//! 命名对齐调用面词汇：transfer（传输）、exec（执行）、terminal
//! （交互连接）。真实实现由 app 用 channel crate 装配；测试替身记录
//! 调用参数并支持故障注入。

use async_trait::async_trait;
use std::sync::Arc;

/// 通道目标身份：沙箱与获准端点。端点缺省时由实现按默认端点接入。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelTarget {
    /// 目标沙箱标识（Gateway 分配的平台身份）。
    pub sandbox_id: String,
    /// 获准端点名称；`None` 表示使用默认接入端点。
    pub endpoint: Option<String>,
}

/// 交互终端通道句柄（trait 化，真实实现基于原生协议字节流）。
pub trait TerminalHandle: Send + Sync + std::fmt::Debug {
    /// 显式回收本地句柄。回收后通道不可再用。
    fn close(&mut self);
    /// 句柄是否仍可用。
    fn is_open(&self) -> bool;
}

/// 文件与命令通道网关。
#[async_trait]
pub trait ChannelGateway: Send + Sync {
    /// 建立文件传输通道并执行一次上传；返回回读字节的长度。
    /// 连接故障时返回 [`ChannelAccessError`]，不自动重试。
    async fn open_file_channel(
        &self,
        target: &ChannelTarget,
        path: &str,
        bytes: &[u8],
    ) -> Result<usize, ChannelAccessError>;

    /// 建立命令通道并执行一次命令；返回输出与退出状态。
    async fn open_exec_channel(
        &self,
        target: &ChannelTarget,
        cmd: &str,
    ) -> Result<CommandOutcome, ChannelAccessError>;

    /// 建立交互终端通道，返回可显式回收的句柄。
    async fn open_terminal(
        &self,
        target: &ChannelTarget,
    ) -> Result<Box<dyn TerminalHandle>, ChannelAccessError>;

    /// 回收一次运行的通道句柄：释放与显式关闭时调用。回收后该运行的
    /// 通道访问返回 [`ChannelAccessError::Closed`]；连接关闭不被当作
    /// 远端任务取消（运行侧无感知，不通知取消）。
    async fn close_sandbox(&self, sandbox_id: &str);
}

/// `Arc<T>` 共享句柄直接实现 trait：app 装配与测试共享可断言替身时使用。
#[async_trait]
impl<T: ChannelGateway + ?Sized> ChannelGateway for Arc<T> {
    async fn open_file_channel(
        &self,
        target: &ChannelTarget,
        path: &str,
        bytes: &[u8],
    ) -> Result<usize, ChannelAccessError> {
        (**self).open_file_channel(target, path, bytes).await
    }
    async fn open_exec_channel(
        &self,
        target: &ChannelTarget,
        cmd: &str,
    ) -> Result<CommandOutcome, ChannelAccessError> {
        (**self).open_exec_channel(target, cmd).await
    }
    async fn open_terminal(
        &self,
        target: &ChannelTarget,
    ) -> Result<Box<dyn TerminalHandle>, ChannelAccessError> {
        (**self).open_terminal(target).await
    }
    async fn close_sandbox(&self, sandbox_id: &str) {
        (**self).close_sandbox(sandbox_id).await
    }
}

/// 命令执行结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutcome {
    /// 合并输出。
    pub output: String,
    /// 退出码。
    pub exit_code: i32,
}

/// 通道接入错误（由调用面映射为 [`crate::sandboxes::error::AccessError`]）。
#[derive(Debug, thiserror::Error)]
pub enum ChannelAccessError {
    /// 连接故障（中断、协议违规），不自动重试上层任务。
    #[error("连接故障：{0}")]
    Connection(String),
    /// 端点鉴权失败。
    #[error("端点鉴权失败：{0}")]
    Auth(String),
    /// 端点不可达。
    #[error("端点不可达：{0}")]
    Unreachable(String),
    /// 目标身份与请求的沙箱/端点不一致。
    #[error("目标身份不一致：{0}")]
    NotAvailable(String),
    /// 通道已被回收，禁止继续使用。
    #[error("通道已回收：{0}")]
    Closed(String),
}
