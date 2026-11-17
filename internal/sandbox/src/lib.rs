//! 执行环境生命周期管理。
//!
//! 负责启动与停止执行环境、提供隔离工作目录、写入输入、读取输出与产物，
//! 并注入凭据且确保凭据不落入产物、日志与事件明文。首版实现本地隔离驱动。

use async_trait::async_trait;

/// 沙箱驱动：抽象执行环境实现（本地目录 / 容器 / 远程）。
#[async_trait]
pub trait Driver: Send + Sync {
    /// 启动一个运行对应的执行环境，返回环境句柄。
    async fn start(&self, run_id: &str) -> Result<Box<dyn Environment>, SandboxError>;
}

/// 执行环境句柄。
#[async_trait]
pub trait Environment: Send + Sync {
    /// 把输入写入环境指定路径。
    async fn write_input(&self, path: &str, content: &[u8]) -> Result<(), SandboxError>;
    /// 从环境指定路径读取输出。
    async fn read_output(&self, path: &str) -> Result<Vec<u8>, SandboxError>;
    /// 注入凭据，实现需保证凭据不落入产物、日志与事件明文。
    async fn inject_credential(&self, name: &str, value: &str) -> Result<(), SandboxError>;
    /// 停止并清理环境。
    async fn stop(&self) -> Result<(), SandboxError>;
}

/// 沙箱错误。
#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("环境启动失败：{0}")]
    Launch(String),
    #[error("输入写入失败：{0}")]
    WriteInput(String),
    #[error("输出读取失败：{0}")]
    ReadOutput(String),
    #[error("环境已停止")]
    Stopped,
}
