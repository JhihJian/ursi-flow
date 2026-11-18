//! 运行存储：SQLite 直连实现（`RunRepository` + `LeaseTable`）。
//!
//! 本域拥有 `runs_domain` 迁移（登记到 app 的统一迁移列表，顺序只可追加），
//! 独立测试直接传给 [`SqliteRunStore::open`]。表结构：
//!
//! - `runs`：运行主表。`snapshot_json` 为创建时冻结的 [`RunSnapshot`]，
//!   提交不改写；`generation` 是持有代数，commit_run 以 CAS 校验；租约
//!   字段（holder/到期时间）同表，acquire 与接管在同一 IMMEDIATE 事务内
//!   递增代数，避免与提交竞争时出现双持有。
//! - `node_runs`：节点状态行。attempts / reworks 随节点状态保存。
//! - `events`：持久事件。seq 由提交事务内 `max(seq)+1` 确定，提交、查询
//!   和广播使用同一记录身份。
//! - `node_artifacts`：产物归属（DESIGN「状态、事件与产物」）。按
//!   (run, node, generation, attempt, name) 记录节点声明产物的轮次归属；
//!   返工后新 attempt 的新记录不覆盖旧轮，旧轮记录保留可查询但不参与
//!   当前轮次。与 artifacts 域联调点：内容存取归 artifacts，本表是 runs
//!   侧的轮次有效性判据。
//! - `cleanup_status`：运行终态后的资源清理结果（pending/done/failed），
//!   失败可查询并重试，与运行执行结果独立。
//!
//! 一致性契约（DESIGN「一致性归属」）：状态、节点与事件在同一事务内原子
//! 提交，任一步失败整体回滚；代数过期（CAS 影响 0 行）返回
//! `StaleGeneration`，不覆盖当前结果。提交成功后广播是调用方（engine）
//! 的职责，存储不感知订阅方。

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use crate::domain::{NodeRun, NodeStatus, Run, RunStatus};

use crate::storage::{Database, Migration, StoreError};

use super::{
    CleanupState, CleanupStatus, Clock, FrozenRoles, LeaseError, LeaseState, LeaseTable,
    NodeArtifactRecord, RunEventRecord, RunRepository, RunSnapshot, RunSummary,
};

/// runs 域迁移（登记到 app 的统一迁移列表，顺序只可追加）。
pub const RUNS_MIGRATIONS: &[Migration] = &[Migration::new(
    "runs_domain",
    "CREATE TABLE runs (
        id                   TEXT PRIMARY KEY,
        snapshot_json        TEXT NOT NULL,
        status               TEXT NOT NULL,
        generation           INTEGER NOT NULL,
        holder               TEXT,
        lease_expires_at_ms  INTEGER,
        updated_at_ms        INTEGER NOT NULL
    );
    CREATE TABLE node_runs (
        run_id    TEXT NOT NULL REFERENCES runs(id),
        node_id   TEXT NOT NULL,
        status    TEXT NOT NULL,
        attempts  INTEGER NOT NULL DEFAULT 0,
        reworks   INTEGER NOT NULL DEFAULT 0,
        output    TEXT,
        error     TEXT,
        PRIMARY KEY (run_id, node_id)
    );
    CREATE TABLE events (
        run_id     TEXT NOT NULL REFERENCES runs(id),
        seq        INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE node_artifacts (
        run_id     TEXT NOT NULL REFERENCES runs(id),
        node_id    TEXT NOT NULL,
        generation INTEGER NOT NULL,
        attempt    INTEGER NOT NULL,
        name       TEXT NOT NULL,
        path       TEXT NOT NULL,
        media_type TEXT,
        required   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, node_id, generation, attempt, name)
    );
    CREATE TABLE cleanup_status (
        run_id    TEXT PRIMARY KEY,
        state     TEXT NOT NULL,
        error     TEXT,
        updated_at_ms INTEGER NOT NULL
    );",
)];

/// 运行存储：rusqlite 直连，自管本域表与租约。
pub struct SqliteRunStore {
    db: Database,
    clock: Arc<dyn Clock>,
}

impl SqliteRunStore {
    /// 打开存储并应用本域迁移。文件不存在则创建。
    /// 本域开启外键约束（node_runs / events 引用 runs 主键），入库时由
    /// SQLite 强制引用完整性。
    pub fn open(path: impl AsRef<Path>, clock: Arc<dyn Clock>) -> Result<Self, StoreError> {
        let db = Database::open(path, RUNS_MIGRATIONS)
            .map_err(|err| StoreError::Storage(err.to_string()))?;
        db.lock_conn()
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|err| StoreError::Storage(err.to_string()))?;
        Ok(Self { db, clock })
    }

    /// 测试辅助：执行一条原始 SQL（构造租约边界的边界态）。
    #[cfg(test)]
    pub(crate) fn test_exec(&self, sql: &str) -> Result<(), StoreError> {
        self.db.with_conn(|conn| conn.execute(sql, []).map(|_| ()))
    }

    /// 锁定连接执行同步操作；闭包错误类型由调用方决定（StoreError 或
    /// LeaseError），rusqlite 错误经各自的 `From` 在闭包内用 `?` 转换。
    fn with_conn<T, E>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, E>,
    ) -> Result<T, E> {
        let mut conn = self.db.lock_conn();
        f(&mut conn)
    }

    fn now_millis(&self) -> i64 {
        self.clock.now_millis()
    }
}

/// 序列化为 JSON，错误映射为存储错误。
fn to_json<T: Serialize>(value: &T) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|e| StoreError::Storage(format!("序列化失败：{e}")))
}

/// 保存运行行（新运行，generation 由调用方给定）。
fn insert_run(
    conn: &Connection,
    run: &Run,
    snapshot: &RunSnapshot,
    now_ms: i64,
) -> Result<(), StoreError> {
    let snapshot_json = to_json(snapshot)?;
    conn.execute(
        "INSERT INTO runs (id, snapshot_json, status, generation, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![run.id, snapshot_json, run.status.as_str(), run.generation as i64, now_ms],
    )?;
    Ok(())
}

/// CAS 更新运行状态：代数只增不减（仅租约 acquire/接管递增），提交
/// 只在当前代数等于期望时改写状态。影响 0 行说明代数过期或运行不存在。
fn update_run_cas(
    conn: &Connection,
    run: &Run,
    expected_generation: u64,
    now_ms: i64,
) -> Result<(), StoreError> {
    let changed = conn.execute(
        "UPDATE runs SET status = ?2, updated_at_ms = ?3
         WHERE id = ?1 AND generation = ?4",
        params![
            run.id,
            run.status.as_str(),
            now_ms,
            expected_generation as i64
        ],
    )?;
    if changed == 0 {
        return Err(StoreError::StaleGeneration(format!(
            "运行 {} 期望代数 {} 不匹配",
            run.id, expected_generation
        )));
    }
    Ok(())
}

/// attempt 回退防护（SPEC「在同一持有代数内返工后，旧 attempt 的迟到状态、
/// 事件或产物不能覆盖当前执行结果」）：提交携带的节点 attempt 小于库内值，
/// 说明是旧 attempt 的迟到提交（同一代数内的返工已推进执行编号），拒绝
/// 整个提交（状态与事件都不落库），当前结果不被覆盖。代数过期检查先行，
/// 这里只补「同代数内」的迟到窗口。
fn guard_attempt_regression(conn: &Connection, run: &Run) -> Result<(), StoreError> {
    for node in &run.nodes {
        let stored: Option<i64> = conn
            .query_row(
                "SELECT attempts FROM node_runs WHERE run_id = ?1 AND node_id = ?2",
                params![run.id, node.node_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(stored) = stored {
            if (node.attempts as i64) < stored {
                return Err(StoreError::StaleGeneration(format!(
                    "节点 {} 提交 attempt {} 小于库内 {}（旧 attempt 迟到提交被拒）",
                    node.node_id, node.attempts, stored
                )));
            }
        }
    }
    Ok(())
}

/// 覆盖节点状态行（UPSERT，随 commit_run 同事务保存）。
fn upsert_node(conn: &Connection, run_id: &str, node: &NodeRun) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO node_runs (run_id, node_id, status, attempts, reworks, output, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(run_id, node_id) DO UPDATE SET
            status = excluded.status,
            attempts = excluded.attempts,
            reworks = excluded.reworks,
            output = excluded.output,
            error = excluded.error",
        params![
            run_id,
            node.node_id,
            node.status.as_str(),
            node.attempts as i64,
            node.reworks as i64,
            node.output,
            node.error
        ],
    )?;
    Ok(())
}

/// 在事务内追加事件：seq 从该运行当前 max(seq)+1 连续分配。
/// 事件身份（run_id, seq）在此确定，提交方广播同一记录。
fn append_events(
    conn: &Connection,
    run_id: &str,
    events: &[crate::domain::TelemetryEvent],
) -> Result<(), StoreError> {
    let mut next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM events WHERE run_id = ?1",
        params![run_id],
        |row| row.get(0),
    )?;
    next += 1;
    for event in events {
        let event_json = to_json(event)?;
        conn.execute(
            "INSERT INTO events (run_id, seq, event_json) VALUES (?1, ?2, ?3)",
            params![run_id, next, event_json],
        )?;
        next += 1;
    }
    Ok(())
}

/// 读取快照 JSON；运行不存在返回 None。
fn load_snapshot(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT snapshot_json FROM runs WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .optional()
}

/// 解析快照 JSON。
fn parse_snapshot(id: &str, json: &str) -> Result<RunSnapshot, StoreError> {
    serde_json::from_str(json).map_err(|e| {
        StoreError::Storage(format!("运行 {id} 快照反序列化失败：{e}"))
    })
}

/// 写入节点产物归属：节点声明逐项落库，同一身份重复记录幂等跳过
/// （INSERT OR IGNORE 主键去重，重试/迟到写不产生重复行）。
fn insert_node_artifacts(
    conn: &Connection,
    run_id: &str,
    node_id: &str,
    generation: u64,
    attempt: u32,
    declared: &[crate::domain::ArtifactContract],
) -> Result<(), StoreError> {
    for c in declared {
        conn.execute(
            "INSERT OR IGNORE INTO node_artifacts
             (run_id, node_id, generation, attempt, name, path, media_type, required)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                run_id,
                node_id,
                generation as i64,
                attempt as i64,
                c.name,
                c.path,
                c.media_type,
                c.required as i64
            ],
        )?;
    }
    Ok(())
}

/// 组装运行对象：主键 + 快照 + 全部节点状态行。
fn assemble_run(
    id: &str,
    snapshot_json: &str,
    status: RunStatus,
    generation: i64,
    nodes: Vec<NodeRun>,
) -> Result<Run, StoreError> {
    let snapshot: RunSnapshot = serde_json::from_str(snapshot_json)
        .map_err(|e| StoreError::Storage(format!("快照反序列化失败：{e}")))?;
    Ok(Run {
        id: id.to_string(),
        workflow: snapshot.workflow,
        status,
        nodes,
        generation: generation as u64,
    })
}

/// 读取运行（含节点状态）；不存在返回 None。
fn load_run(conn: &Connection, id: &str) -> Result<Option<Run>, StoreError> {
    let Some(snapshot_json) = load_snapshot(conn, id)? else {
        return Ok(None);
    };
    let (status, generation) = conn.query_row(
        "SELECT status, generation FROM runs WHERE id = ?1",
        params![id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    )?;
    let status = RunStatus::parse(&status).ok_or_else(|| {
        StoreError::Storage(format!("运行 {id} 存储了非法状态 {status}"))
    })?;
    let nodes = load_nodes(conn, id)?;
    Ok(Some(assemble_run(id, &snapshot_json, status, generation, nodes)?))
}

/// 读取节点状态行。
fn load_nodes(conn: &Connection, run_id: &str) -> Result<Vec<NodeRun>, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT node_id, status, attempts, reworks, output, error
         FROM node_runs WHERE run_id = ?1 ORDER BY node_id ASC",
    )?;
    let rows = stmt.query_map(params![run_id], |row| {
        let status: String = row.get(1)?;
        Ok(NodeRun {
            node_id: row.get(0)?,
            status: NodeStatus::parse(&status)
                .ok_or_else(|| rusqlite::Error::InvalidQuery)?,
            output: row.get(4)?,
            error: row.get(5)?,
            attempts: row.get::<_, i64>(2)? as u32,
            reworks: row.get::<_, i64>(3)? as u32,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<NodeRun>>>()?)
}

#[async_trait]
impl RunRepository for SqliteRunStore {
    async fn create_run(&self, run: &Run, frozen_roles: &FrozenRoles) -> Result<(), StoreError> {
        let snapshot = RunSnapshot {
            workflow: run.workflow.clone(),
            roles: frozen_roles.clone(),
        };
        let now_ms = self.now_millis();
        self.with_conn(|conn| {
            let tx = conn.transaction()?;
            insert_run(&tx, run, &snapshot, now_ms)?;
            for node in &run.nodes {
                upsert_node(&tx, &run.id, node)?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    async fn get_run(&self, id: &str) -> Result<Option<Run>, StoreError> {
        self.with_conn(|conn| load_run(conn, id))
    }

    async fn get_snapshot(&self, id: &str) -> Result<Option<RunSnapshot>, StoreError> {
        self.with_conn(|conn| {
            match load_snapshot(conn, id)? {
                None => Ok(None),
                Some(json) => Ok(Some(parse_snapshot(id, &json)?)),
            }
        })
    }

    async fn record_node_artifacts(
        &self,
        run_id: &str,
        node_id: &str,
        generation: u64,
        attempt: u32,
        declared: &[crate::domain::ArtifactContract],
    ) -> Result<(), StoreError> {
        self.with_conn(|conn| {
            let tx = conn.transaction()?;
            insert_node_artifacts(&tx, run_id, node_id, generation, attempt, declared)?;
            tx.commit()?;
            Ok(())
        })
    }

    async fn list_node_artifacts(
        &self,
        run_id: &str,
    ) -> Result<Vec<NodeArtifactRecord>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT node_id, generation, attempt, name, path, media_type, required
                 FROM node_artifacts WHERE run_id = ?1
                 ORDER BY node_id ASC, generation ASC, attempt ASC, name ASC",
            )?;
            let rows = stmt.query_map(params![run_id], |row| {
                Ok(NodeArtifactRecord {
                    run_id: run_id.to_string(),
                    node_id: row.get(0)?,
                    generation: row.get::<_, i64>(1)? as u64,
                    attempt: row.get::<_, i64>(2)? as u32,
                    name: row.get(3)?,
                    path: row.get(4)?,
                    media_type: row.get(5)?,
                    required: row.get::<_, i64>(6)? != 0,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    async fn set_cleanup_status(
        &self,
        run_id: &str,
        state: CleanupState,
        error: Option<&str>,
    ) -> Result<(), StoreError> {
        let now_ms = self.now_millis();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO cleanup_status (run_id, state, error, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(run_id) DO UPDATE SET
                    state = excluded.state,
                    error = excluded.error,
                    updated_at_ms = excluded.updated_at_ms",
                params![run_id, state.as_str(), error, now_ms],
            )?;
            Ok(())
        })
    }

    async fn cleanup_status(&self, run_id: &str) -> Result<Option<CleanupStatus>, StoreError> {
        self.with_conn(|conn| {
            let row: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT state, error FROM cleanup_status WHERE run_id = ?1",
                    params![run_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            match row {
                None => Ok(None),
                Some((state, error)) => {
                    let state = CleanupState::parse(&state).ok_or_else(|| {
                        StoreError::Storage(format!("清理状态非法：{state}"))
                    })?;
                    Ok(Some(CleanupStatus { run_id: run_id.to_string(), state, error }))
                }
            }
        })
    }

    async fn commit_run(
        &self,
        run: &Run,
        expected_generation: u64,
        events: &[crate::domain::TelemetryEvent],
    ) -> Result<(), StoreError> {
        let now_ms = self.now_millis();
        self.with_conn(|conn| {
            let tx = conn.transaction()?;
            update_run_cas(&tx, run, expected_generation, now_ms)?;
            guard_attempt_regression(&tx, run)?;
            for node in &run.nodes {
                upsert_node(&tx, &run.id, node)?;
            }
            append_events(&tx, &run.id, events)?;
            tx.commit()?;
            Ok(())
        })
    }

    async fn list_events(&self, run_id: &str) -> Result<Vec<RunEventRecord>, StoreError> {
        self.list_events_since_impl(run_id, 0)
    }

    async fn list_events_since(
        &self,
        run_id: &str,
        after_seq: i64,
    ) -> Result<Vec<RunEventRecord>, StoreError> {
        self.list_events_since_impl(run_id, after_seq)
    }

    async fn list_runs(&self, statuses: &[RunStatus]) -> Result<Vec<RunSummary>, StoreError> {
        fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunSummary> {
            let status: String = row.get(1)?;
            Ok(RunSummary {
                id: row.get(0)?,
                status: RunStatus::parse(&status).ok_or(rusqlite::Error::InvalidQuery)?,
            })
        }
        self.with_conn(|conn| {
            let rows = if statuses.is_empty() {
                let mut stmt = conn.prepare(
                    "SELECT id, status FROM runs ORDER BY updated_at_ms DESC, id ASC",
                )?;
                let rows = stmt.query_map([], map_row)?;
                rows.collect::<rusqlite::Result<Vec<RunSummary>>>()?
            } else {
                let placeholders = statuses.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
                let sql = format!(
                    "SELECT id, status FROM runs WHERE status IN ({placeholders}) \
                     ORDER BY updated_at_ms DESC, id ASC"
                );
                let mut stmt = conn.prepare(&sql)?;
                let refs: Vec<&str> = statuses.iter().map(|s| s.as_str()).collect();
                let rows = stmt.query_map(rusqlite::params_from_iter(refs), map_row)?;
                rows.collect::<rusqlite::Result<Vec<RunSummary>>>()?
            };
            Ok(rows)
        })
    }
}

impl SqliteRunStore {
    /// 游标读取实现：seq 升序。
    fn list_events_since_impl(
        &self,
        run_id: &str,
        after_seq: i64,
    ) -> Result<Vec<RunEventRecord>, StoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT seq, event_json FROM events
                 WHERE run_id = ?1 AND seq > ?2 ORDER BY seq ASC",
            )?;
            let rows = stmt.query_map(params![run_id, after_seq], |row| {
                let seq: i64 = row.get(0)?;
                let json: String = row.get(1)?;
                Ok((seq, json))
            })?;
            let mut records = Vec::new();
            for row in rows {
                let (seq, json) = row?;
                let event: crate::domain::TelemetryEvent = serde_json::from_str(&json)
                    .map_err(|e| StoreError::Storage(format!("事件 {run_id}#{seq} 反序列化失败：{e}")))?;
                records.push(RunEventRecord {
                    run_id: run_id.to_string(),
                    seq,
                    event,
                });
            }
            Ok(records)
        })
    }
}

#[async_trait]
impl LeaseTable for SqliteRunStore {
    async fn acquire_lease(
        &self,
        run_id: &str,
        holder: &str,
        ttl_ms: u64,
    ) -> Result<u64, LeaseError> {
        let now_ms = self.now_millis();
        let expires_at = now_ms + ttl_ms as i64;
        self.with_conn(|conn| {
            let tx = conn.transaction()?;
            // 行锁：同一运行的租约操作与提交串行化。
            let (generation, holder_now, expires_now): (i64, Option<String>, Option<i64>) = tx
                .query_row(
                    "SELECT generation, holder, lease_expires_at_ms FROM runs WHERE id = ?1",
                    params![run_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()? // rusqlite::Error → LeaseError（含 NotFound→Storage 映射不上，optional 已转 None）
                .ok_or_else(|| LeaseError::NotFound(run_id.to_string()))?;
            let free = match &holder_now {
                // 无租约或已到期（含时钟推进后的过期）才可获取。
                None => true,
                Some(h) => {
                    let exp = expires_now.unwrap_or(0);
                    exp <= now_ms
                        // 幂等：同一持有者重复获取视为续约语义的获取。
                        || h == holder
                }
            };
            if !free {
                return Err(LeaseError::Held {
                    run_id: run_id.to_string(),
                    holder: holder_now.unwrap_or_default(),
                });
            }
            let new_generation = generation + 1;
            tx.execute(
                "UPDATE runs SET generation = ?2, holder = ?3, lease_expires_at_ms = ?4,
                    updated_at_ms = ?5 WHERE id = ?1",
                params![run_id, new_generation, holder, expires_at, now_ms],
            )?;
            tx.commit()?;
            Ok(new_generation as u64)
        })
    }

    async fn renew_lease(
        &self,
        run_id: &str,
        holder: &str,
        ttl_ms: u64,
    ) -> Result<(), LeaseError> {
        let now_ms = self.now_millis();
        self.with_conn(|conn| {
            let tx = conn.transaction()?;
            let (holder_now, expires_now): (Option<String>, Option<i64>) = tx
                .query_row(
                    "SELECT holder, lease_expires_at_ms FROM runs WHERE id = ?1",
                    params![run_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| LeaseError::NotFound(run_id.to_string()))?;
            match holder_now.as_deref() {
                None => return Err(LeaseError::NoLease(run_id.to_string())),
                Some(h) if h != holder => {
                    return Err(LeaseError::Held {
                        run_id: run_id.to_string(),
                        holder: h.to_string(),
                    })
                }
                Some(_) => {}
            }
            // 已到期的租约不能续，必须重新接管（代数递增）。
            if expires_now.unwrap_or(0) <= now_ms {
                return Err(LeaseError::Expired {
                    run_id: run_id.to_string(),
                    holder: holder.to_string(),
                });
            }
            tx.execute(
                "UPDATE runs SET lease_expires_at_ms = ?3, updated_at_ms = ?4
                 WHERE id = ?1 AND holder = ?2",
                params![run_id, holder, now_ms + ttl_ms as i64, now_ms],
            )?;
            tx.commit()?;
            Ok(())
        })
    }

    async fn check_lease(&self, run_id: &str) -> Result<Option<LeaseState>, LeaseError> {
        let now_ms = self.now_millis();
        self.with_conn(|conn| {
            let row: Option<(i64, Option<String>, Option<i64>)> = conn
                .query_row(
                    "SELECT generation, holder, lease_expires_at_ms FROM runs WHERE id = ?1",
                    params![run_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            match row {
                None => Err(LeaseError::NotFound(run_id.to_string())),
                Some((generation, holder, expires)) => Ok(holder.map(|holder| LeaseState {
                    holder,
                    generation: generation as u64,
                    expires_at_ms: expires.unwrap_or(0),
                    expired: expires.unwrap_or(0) <= now_ms,
                })),
            }
        })
    }
}
