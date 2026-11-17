//! 共享存储基础设施：SQLite 连接与迁移、事务上下文和稳定内容存储。
//!
//! 业务表、查询与 repository 属于各自业务域，storage 只提供三类基础能力：
//!
//! - [`Database`]：按顺序应用调用方登记的迁移列表并持久化版本号；
//! - [`Transaction`]：多个域 repository 共用的事务上下文，退出未提交自动回滚；
//! - [`ContentStore`]:以内容寻址（sha256 hex）稳定保存文件内容并保证路径边界。
//!
//! 跨域操作由 app 用例编排，各域 repository 通过 [`Database::conn`] 取得同一
//! 连接句柄，在事务上下文内看到同一一致性视图。

mod content;
mod db;

pub use content::{ContentError, ContentStore};
pub use db::{Database, Migration, Transaction};

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

impl From<rusqlite::Error> for StoreError {
    fn from(err: rusqlite::Error) -> Self {
        StoreError::Storage(err.to_string())
    }
}
