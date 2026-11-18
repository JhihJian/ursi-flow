//! 执行环境句柄：沙箱内执行面的统一抽象（domain 契约）。
//!
//! 定义命令与文件操作契约，由装配方注入实现。该接口不拥有沙箱生命周期，
//! 也不决定执行位置；Channel 管服务端连接，沙箱内 CLI Adapter 使用本地环境。

use async_trait::async_trait;

/// 执行环境句柄。
#[async_trait]
pub trait ExecutionEnv: Send + Sync {
    /// 在环境内执行一条命令，返回 (退出码, 合并输出)。
    async fn exec(&self, cmd: &str) -> Result<(i32, String), EnvError>;

    /// 把输入写入环境内指定路径。
    async fn write_file(&self, path: &str, content: &[u8]) -> Result<(), EnvError>;

    /// 从环境内指定路径读取文件；不存在时返回明确错误。
    async fn read_file(&self, path: &str) -> Result<Vec<u8>, EnvError>;
}

/// 环境操作错误。
#[derive(Debug, thiserror::Error)]
pub enum EnvError {
    #[error("环境内文件不存在：{0}")]
    FileNotFound(String),
    #[error("命令执行失败：{0}")]
    Exec(String),
    #[error("环境错误：{0}")]
    Other(String),
}
