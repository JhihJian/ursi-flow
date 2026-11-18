//! 沙箱关联存储。运行主键唯一占用操作身份和冻结规格，跨 SQLite 连接也有效。
//! 不跨网络请求持锁。回包只按已占用身份、资源标识和当前状态作条件更新。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use super::StoreError;
use super::model::{EndpointView, GatewaySandboxStatus};
use super::state::{DomainSandboxState, PlatformView, RequestRecord};

const MIGRATION_SANDBOXES_DOMAIN: &str = "sandboxes_domain";
const SCHEMA_VERSION: i32 = 1;

/// 本域存储。
pub struct SandboxStore {
    conn: Mutex<Connection>,
}

impl SandboxStore {
    /// 打开（或创建）SQLite 数据库并应用本域迁移。
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let mut conn = Connection::open(path.as_ref())?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i32 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(StoreError::Storage(format!(
                "数据库 schema 版本 {version} 高于本模块支持的 {SCHEMA_VERSION}"
            )));
        }
        if version == 0 {
            tx.execute_batch(
                "CREATE TABLE sandbox_links (
                     run_id               TEXT PRIMARY KEY,
                     sandbox_id           TEXT,
                     prepare_operation_id TEXT NOT NULL,
                     state                TEXT NOT NULL,
                     spec_json            TEXT NOT NULL,
                     gateway_status       TEXT,
                     endpoints_json       TEXT,
                     gateway_summary      TEXT,
                     last_error           TEXT,
                     updated_at           TEXT NOT NULL
                 );
                 CREATE TABLE access_grants (
                     run_id       TEXT PRIMARY KEY REFERENCES sandbox_links(run_id),
                     endpoint     TEXT,
                     granted_at   TEXT NOT NULL
                 );
                 PRAGMA user_version = 1;",
            )?;
        }
        tx.commit()?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 迁移登记名。
    pub fn migration_name() -> &'static str {
        MIGRATION_SANDBOXES_DOMAIN
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("沙箱域存储锁中毒")
    }

    /// 仅首次申请可以写身份、规格。竞争方读取胜者的记录，不使用候选身份。
    pub(super) fn reserve(&self, candidate: &RequestRecord) -> Result<RequestRecord, StoreError> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO sandbox_links (run_id, prepare_operation_id, spec_json, state, updated_at)
             VALUES (?1, ?2, ?3, 'PreparePending', ?4) ON CONFLICT(run_id) DO NOTHING",
            params![
                candidate.run_id,
                candidate.prepare_operation_id,
                candidate.spec_json,
                candidate.updated_at
            ],
        )?;
        Ok(conn.query_row(
            "SELECT * FROM sandbox_links WHERE run_id = ?1",
            [&candidate.run_id],
            row_to_request,
        )?)
    }

    /// 按运行标识取请求记录；不存在返回 None。
    pub fn request_record(&self, run_id: &str) -> Result<Option<RequestRecord>, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT * FROM sandbox_links WHERE run_id = ?1",
                [run_id],
                row_to_request,
            )
            .optional()?)
    }

    /// 最近观测为就绪的关联。不能据此放行通道操作。
    pub fn confirmed_link(&self, run_id: &str) -> Result<Option<(String, String)>, StoreError> {
        Ok(self
            .request_record(run_id)?
            .filter(|r| r.state == DomainSandboxState::Ready)
            .and_then(|r| r.sandbox_id.map(|id| (id, r.spec_json))))
    }

    /// 平台视图：本地关联加最近平台快照。
    pub fn platform_view(&self, run_id: &str) -> Result<Option<PlatformView>, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT * FROM sandbox_links WHERE run_id = ?1",
                [run_id],
                row_to_view,
            )
            .optional()?)
    }

    /// 迟到的 POST 可以补齐释放所需的 id，但不能更改既有 id 或撤销释放意图。
    pub(super) fn bind_id(&self, record: &RequestRecord, id: &str) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE sandbox_links SET sandbox_id = ?3,
                state = CASE WHEN state = 'ReleasePending' THEN state ELSE 'PreparePending' END,
                last_error = NULL, updated_at = ?4
             WHERE run_id = ?1 AND prepare_operation_id = ?2 AND sandbox_id IS NULL AND state != 'Released'",
            params![record.run_id, record.prepare_operation_id, id, super::now_rfc3339()],
        )?;
        Ok(())
    }

    /// 错误不丢失身份或最近快照。旧准备失败不能降级已绑定的资源或覆盖释放结果。
    pub(super) fn note_error(
        &self,
        record: &RequestRecord,
        state: DomainSandboxState,
        message: &str,
    ) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE sandbox_links SET state = ?4, last_error = ?5, updated_at = ?6
             WHERE run_id = ?1 AND prepare_operation_id = ?2 AND sandbox_id IS ?3
               AND state != 'Released' AND (state = 'ReleasePending') = (?4 = 'ReleasePending')",
            params![
                record.run_id,
                record.prepare_operation_id,
                record.sandbox_id,
                state.as_str(),
                message,
                super::now_rfc3339()
            ],
        )?;
        Ok(())
    }

    /// 同一条语句返回本次 GET 的准入判定；并发释放只允许更新快照。
    pub(super) fn observe(
        &self,
        run_id: &str,
        id: &str,
        status: GatewaySandboxStatus,
        ready: bool,
        endpoints_json: &str,
    ) -> Result<Option<PlatformView>, StoreError> {
        let state = if ready {
            DomainSandboxState::Ready
        } else {
            DomainSandboxState::PreparePending
        };
        Ok(self
            .conn()
            .query_row(
                "UPDATE sandbox_links SET gateway_status = ?3, endpoints_json = ?4,
                 state = CASE WHEN state = 'ReleasePending' THEN state ELSE ?5 END,
                 last_error = CASE WHEN state = 'ReleasePending' THEN last_error ELSE NULL END,
                 updated_at = ?6
             WHERE run_id = ?1 AND sandbox_id = ?2 AND state != 'Released' RETURNING *",
                params![
                    run_id,
                    id,
                    status_text(status),
                    endpoints_json,
                    state.as_str(),
                    super::now_rfc3339()
                ],
                row_to_view,
            )
            .optional()?)
    }

    /// 在任何远端释放动作前持久化意图，并在同一事务中撤销本地准入。
    pub(super) fn begin_release(&self, run_id: &str) -> Result<Option<RequestRecord>, StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE sandbox_links SET state = 'ReleasePending', updated_at = ?2
                    WHERE run_id = ?1 AND state NOT IN ('ReleasePending','Released')",
            params![run_id, super::now_rfc3339()],
        )?;
        tx.execute("DELETE FROM access_grants WHERE run_id = ?1", [run_id])?;
        let record = tx
            .query_row(
                "SELECT * FROM sandbox_links WHERE run_id = ?1",
                [run_id],
                row_to_request,
            )
            .optional()?;
        tx.commit()?;
        Ok(record)
    }

    pub(super) fn confirm_release(&self, run_id: &str, id: &str) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE sandbox_links SET state = 'Released', last_error = NULL, updated_at = ?3
             WHERE run_id = ?1 AND sandbox_id = ?2 AND state = 'ReleasePending'",
            params![run_id, id, super::now_rfc3339()],
        )?;
        Ok(())
    }

    /// GET 之后还须原子检查当前准入状态，不能在释放已经开始后重新登记。
    pub(super) fn record_grant(
        &self,
        run_id: &str,
        id: &str,
        endpoint: Option<&str>,
    ) -> Result<bool, StoreError> {
        Ok(self.conn().execute(
            "INSERT INTO access_grants (run_id, endpoint, granted_at)
             SELECT run_id, ?3, ?4 FROM sandbox_links WHERE run_id = ?1 AND sandbox_id = ?2 AND state = 'Ready'
             ON CONFLICT(run_id) DO UPDATE SET endpoint = excluded.endpoint, granted_at = excluded.granted_at",
            params![run_id, id, endpoint, super::now_rfc3339()],
        )? == 1)
    }

    /// 最近登记的准入端点；没有授权端点时为 None。
    pub fn access_grant(&self, run_id: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT endpoint FROM access_grants WHERE run_id = ?1",
                [run_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    pub(super) fn clear_access_grant(&self, run_id: &str) -> Result<(), StoreError> {
        self.conn()
            .execute("DELETE FROM access_grants WHERE run_id = ?1", [run_id])?;
        Ok(())
    }
}

fn status_text(status: GatewaySandboxStatus) -> &'static str {
    match status {
        GatewaySandboxStatus::Preparing => "preparing",
        GatewaySandboxStatus::Running => "running",
        GatewaySandboxStatus::Stopped => "stopped",
        GatewaySandboxStatus::Deleting => "deleting",
        GatewaySandboxStatus::Error => "error",
    }
}

pub(crate) fn parse_status(text: &str) -> Option<GatewaySandboxStatus> {
    match text {
        "preparing" => Some(GatewaySandboxStatus::Preparing),
        "running" => Some(GatewaySandboxStatus::Running),
        "stopped" => Some(GatewaySandboxStatus::Stopped),
        "deleting" => Some(GatewaySandboxStatus::Deleting),
        "error" => Some(GatewaySandboxStatus::Error),
        _ => None,
    }
}

fn row_to_request(row: &rusqlite::Row<'_>) -> rusqlite::Result<RequestRecord> {
    let state: String = row.get("state")?;
    Ok(RequestRecord {
        run_id: row.get("run_id")?,
        sandbox_id: row.get("sandbox_id")?,
        prepare_operation_id: row.get("prepare_operation_id")?,
        state: DomainSandboxState::parse(&state),
        spec_json: row.get("spec_json")?,
        gateway_summary: row.get("gateway_summary")?,
        last_error: row.get("last_error")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_view(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlatformView> {
    let request = row_to_request(row)?;
    let endpoints_json: Option<String> = row.get("endpoints_json")?;
    let status: Option<String> = row.get("gateway_status")?;
    Ok(PlatformView {
        run_id: request.run_id,
        sandbox_id: request.sandbox_id,
        state: request.state,
        prepare_operation_id: request.prepare_operation_id,
        gateway_status: status.as_deref().and_then(parse_status),
        endpoints: endpoints_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<EndpointView>>(s).ok())
            .unwrap_or_default(),
        last_error: request.last_error,
        updated_at: request.updated_at,
    })
}
