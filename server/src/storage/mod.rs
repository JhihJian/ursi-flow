//! 共享存储基础设施：连接、迁移和事务，业务存储接口归各自模块。
//!
//! 当前提供共享存储错误类型。SQLite 与事务实现按本模块 SPEC 交付。
//! 跨域操作由应用用例编排，各域 repository 使用同一事务上下文。

/// 存储错误，供各域 repository 映射为业务错误。
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("资源不存在：{0}")]
    NotFound(String),
    #[error("状态提交被拒绝（代数过期）：{0}")]
    StaleGeneration(String),
    #[error("存储错误：{0}")]
    Storage(String),
}
