//! 状态存储：SQLite 持久化沙箱记录。
//!
//! 状态迁移使用 CAS 语义（from-status 条件更新），创建规格在创建时冻结，
//! 恢复不依赖 gateway 默认值。

/// 存储骨架占位：parity 移植 store.go 与 store_test.go 时填充。
pub struct Store;
