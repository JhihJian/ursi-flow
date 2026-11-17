//! Gateway 客户端与运行资源关联。
//!
//! server 请求 Gateway 准备或释放资源，Gateway lifecycle 管理资源状态和
//! 对账。输入输出由 Channel 传输，agent 会话经 Agent Runtime 控制。
//! 当前仅定义客户端接口，HTTP 实现与测试替身尚未实现。

use async_trait::async_trait;

/// 沙箱控制入口：面向运行的沙箱生命周期编排。
#[async_trait]
pub trait SandboxControl: Send + Sync {
    /// 为一次运行准备沙箱环境，返回控制面沙箱 ID。
    async fn prepare(&self, run_id: &str) -> Result<String, SandboxError>;
    /// 请求释放一次运行的沙箱；失败必须显式返回，以便记录和重试。
    async fn release(&self, run_id: &str) -> Result<(), SandboxError>;
}

/// 沙箱编排错误。
#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("控制面调用失败：{0}")]
    Gateway(String),
    #[error("沙箱不存在：{0}")]
    NotFound(String),
    #[error("功能尚未实现：{0}")]
    NotImplemented(String),
}
