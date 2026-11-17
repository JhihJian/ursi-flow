//! 执行环境句柄：沙箱内执行面的统一抽象（domain 契约）。
//!
//! Runner 通过该 trait 操作执行环境（发命令、读写文件、收日志），
//! 不感知环境是本地目录还是沙箱容器。server 的 sandbox 模块与 channel 提供实现，
//! engine 负责把实现注入给 Runner。trait 定义在 domain，保证
//! executor 不依赖 sandbox crate。

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
