//! SQLite 连接、迁移与事务上下文。
//!
//! [`Database`] 包装单个 `Arc<Mutex<Connection>>`：打开时配置 WAL、busy_timeout
//! 与 FULLMUTEX，按调用方（app）登记的迁移列表顺序应用，用 `PRAGMA user_version`
//! 持久化版本，版本已达标则跳过迁移；每条迁移在独立事务内执行，失败整体回滚
//! 且版本不前进。
//!
//! [`Transaction`] 是调用方控制的显式事务上下文：`begin` 之后提交前独占连接，
//! 多个域 repository 经 [`Transaction::conn`] 共用同一一致性视图，作用域退出
//! 未提交自动回滚（guard 模式）。rusqlite 是同步接口，事务内操作全部同步执行；
//! 异步调用方按需用 `tokio::task::block_in_place` 包裹。
//!
//! 打开临时库（测试与独立验收）：调用方创建 `tempfile::TempDir` 后用
//! [`Database::open`] 指向其中的文件路径。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{OpenFlags, TransactionBehavior};

use super::StoreError;

/// 一条迁移：名称仅用于错误定位，`sql` 可包含多条语句（execute_batch 执行）。
/// 迁移由 app 按域登记并合成统一列表，列表只能追加，不可改写历史条目。
#[derive(Debug, Clone)]
pub struct Migration {
    pub name: &'static str,
    pub sql: &'static str,
}

impl Migration {
    pub const fn new(name: &'static str, sql: &'static str) -> Self {
        Self { name, sql }
    }
}

/// 迁移或连接错误。失败迁移的版本号不前进，重开数据库会重试。
#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    #[error("迁移 {migration} 执行失败：{source}")]
    Failed {
        migration: &'static str,
        source: rusqlite::Error,
    },
    #[error("登记的迁移数量 {registered} 与库内版本 {stored} 不一致：迁移列表只能追加")]
    VersionMismatch { registered: usize, stored: u32 },
    #[error("打开数据库失败：{0}")]
    Open(String),
}

/// 共享 SQLite 数据库：迁移由 app 登记并在此统一应用。
#[derive(Debug, Clone)]
pub struct Database {
    conn: Arc<Mutex<rusqlite::Connection>>,
    path: PathBuf,
}

impl Database {
    /// 从路径打开数据库并应用迁移。文件不存在则创建（SQLITE_OPEN_CREATE）。
    pub fn open(path: impl AsRef<Path>, migrations: &[Migration]) -> Result<Self, MigrationError> {
        let conn = Self::connect(path.as_ref())?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            path: path.as_ref().to_path_buf(),
        };
        db.apply_migrations(migrations)?;
        Ok(db)
    }

    fn connect(path: &Path) -> Result<rusqlite::Connection, MigrationError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| MigrationError::Open(e.to_string()))?;
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_FULL_MUTEX
            | OpenFlags::SQLITE_OPEN_URI;
        let conn = rusqlite::Connection::open_with_flags(path, flags)
            .map_err(|e| MigrationError::Open(e.to_string()))?;
        conn.busy_timeout(BUSY_TIMEOUT)
            .map_err(|e| MigrationError::Open(e.to_string()))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| MigrationError::Open(e.to_string()))?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(|e| MigrationError::Open(e.to_string()))?;
        Ok(conn)
    }

    /// 按登记顺序应用迁移，版本持久化在 `PRAGMA user_version`。
    ///
    /// 每条迁移与版本号写入同一事务：任一语句失败整体回滚，版本不前进，
    /// 不残留半张表。库内版本超过登记数量说明迁移列表被错误回退，拒绝打开。
    fn apply_migrations(&self, migrations: &[Migration]) -> Result<(), MigrationError> {
        let mut conn = self.conn.lock().expect("数据库连接互斥锁中毒");
        let stored: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| MigrationError::Open(e.to_string()))?;
        let stored = usize::try_from(stored).map_err(|_| MigrationError::VersionMismatch {
            registered: migrations.len(),
            stored: u32::MAX,
        })?;

        if stored > migrations.len() {
            return Err(MigrationError::VersionMismatch {
                registered: migrations.len(),
                stored: stored as u32,
            });
        }

        for (index, migration) in migrations.iter().enumerate().skip(stored) {
            let apply = |tx: &rusqlite::Transaction<'_>| -> rusqlite::Result<()> {
                tx.execute_batch(migration.sql)?;
                // 版本号与迁移语句同事务提交，保证「失败不被记录为成功」。
                tx.pragma_update(None, "user_version", index as i64 + 1)
            };
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|source| MigrationError::Failed {
                    migration: migration.name,
                    source,
                })?;
            apply(&tx).map_err(|source| MigrationError::Failed {
                migration: migration.name,
                source,
            })?;
            tx.commit().map_err(|source| MigrationError::Failed {
                migration: migration.name,
                source,
            })?;
        }
        Ok(())
    }

    /// 连接句柄：各域 repository 与事务上下文共用此句柄。
    pub fn conn(&self) -> Arc<Mutex<rusqlite::Connection>> {
        self.conn.clone()
    }

    /// 锁定连接执行一段同步操作（repository 实现的基础入口）。
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&mut rusqlite::Connection) -> rusqlite::Result<T>,
    ) -> Result<T, StoreError> {
        let mut conn = self.lock_conn();
        f(&mut conn).map_err(StoreError::from)
    }

    /// 开启显式事务：由调用方 commit / rollback，作用域退出未提交自动回滚。
    pub fn begin(&self) -> Result<Transaction<'_>, StoreError> {
        Transaction::begin(self)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn lock_conn(&self) -> MutexGuard<'_, rusqlite::Connection> {
        self.conn.lock().expect("数据库连接互斥锁中毒")
    }
}

/// 事务与迁移锁冲突的等待上限。
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// 显式事务上下文：begin 后提交前持锁，退出未提交自动回滚。
///
/// 持有连接互斥锁直到结束，保证事务内的所有参与者（多个域 repository）
/// 看到同一一致性视图；其他连接的写入按 busy_timeout 等待或显式报错。
///
/// 注意：事务作用域内必须经 [`Transaction::conn`] 操作，不要在同一线程
/// 再锁 [`Database::conn`] 返回的句柄（互斥锁不可重入，会死锁）。
pub struct Transaction<'a> {
    conn: Option<MutexGuard<'a, rusqlite::Connection>>,
    done: bool,
}

impl<'a> Transaction<'a> {
    fn begin(db: &'a Database) -> Result<Self, StoreError> {
        let conn = db.lock_conn();
        // IMMEDIATE 在 BEGIN 时获取写锁，避免事务中途升级引发的死锁回滚。
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(StoreError::from)?;
        Ok(Self {
            conn: Some(conn),
            done: false,
        })
    }

    /// 锁定的事务内连接，repository 操作经它执行。
    pub fn conn(&mut self) -> &mut rusqlite::Connection {
        self.conn
            .as_mut()
            .expect("事务已在 commit/rollback 后结束")
    }

    /// 提交事务。出错时连接恢复可用（SQLite 自动回滚活动事务）。
    pub fn commit(mut self) -> Result<(), StoreError> {
        if let Some(conn) = self.conn.as_mut() {
            conn.execute_batch("COMMIT").map_err(StoreError::from)?;
        }
        self.done = true;
        Ok(())
    }

    /// 显式回滚。
    pub fn rollback(mut self) {
        self.finish_rollback();
    }

    fn finish_rollback(&mut self) {
        if let Some(conn) = self.conn.as_mut() {
            let _ = conn.execute_batch("ROLLBACK");
        }
        self.done = true;
    }
}

impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.finish_rollback();
        }
    }
}

#[cfg(test)]
mod tests;
