//! 本域存储：运行与 Gateway 沙箱的关联及请求结果，rusqlite 直连自管迁移。
//!
//! 过渡设计说明：本模块当前不依赖 `crate::storage` 的事务与迁移设施，
//! 改为模块内 rusqlite 直连建表、按 `user_version` 自管迁移（与
//! connections 域相同的过渡约定）。后续集成时由 app 统一接线。
//!
//! schema（`sandboxes_domain` 迁移，user_version=1）：
//! - `sandbox_links`：运行与沙箱的关联及最近一次请求身份与结果；
//! - `access_grants`：通道接入的准入记录（平台端点授权）。
//!
//! 并发模型：全局 `Mutex<Connection>` 串行化访问；各写操作在互斥内
//! 完成「读-判-写」，不会交错产生重复关联。
//!
//! 请求身份持久化：prepare 的 `prepare_operation_id` 是跨进程稳定的
//! 幂等键，进程重启或存储重开后以相同身份重试，Gateway 幂等键绑定
//! 保证不额外分配资源。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use super::model::{EndpointView, GatewaySandboxStatus};
use super::state::{DomainSandboxState, PlatformView, RequestRecord};
use super::StoreError;

/// 自管迁移名（`sandboxes_domain`）：建表并置 user_version=1。
const MIGRATION_SANDBOXES_DOMAIN: &str = "sandboxes_domain";
const SCHEMA_VERSION: i32 = 1;

/// 本域存储。
pub struct SandboxStore {
    conn: Mutex<Connection>,
}

impl SandboxStore {
    /// 打开（或创建）SQLite 数据库并应用本域迁移。
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let conn = Connection::open(path.as_ref())?;
        Self::migrate(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// 自管迁移：按 `user_version` 递进建表。
    fn migrate(conn: &Connection) -> Result<(), StoreError> {
        let version: i32 = conn
            .query_row("SELECT user_version FROM pragma_user_version", [], |r| r.get(0))
            .map_err(StoreError::from)?;
        if version > SCHEMA_VERSION {
            return Err(StoreError::Storage(format!(
                "数据库 schema 版本 {version} 高于本模块支持的 {SCHEMA_VERSION}"
            )));
        }
        if version == 0 {
            conn.execute_batch(
                // 迁移名 sandboxes_domain 记录于迁移登记（本模块自管）。
                "BEGIN;
                 CREATE TABLE sandbox_links (
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
                 PRAGMA user_version = 1;
                 COMMIT;",
            )
            .map_err(StoreError::from)?;
        }
        Ok(())
    }

    /// 迁移登记名（app 统一登记迁移列表时使用）。
    pub fn migration_name() -> &'static str {
        MIGRATION_SANDBOXES_DOMAIN
    }

    /// 在互斥内执行（写入原子性由互斥保证，见文件头）。
    fn execute<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let guard = self.conn.lock().expect("沙箱域存储锁中毒");
        f(&guard)
    }

    fn row_to_view(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlatformView> {
        let request = row_to_request(row)?;
        let endpoints_json: Option<String> = row.get("endpoints_json")?;
        let status_str: Option<String> = row.get("gateway_status")?;
        let endpoints = endpoints_json
            .as_deref()
            .and_then(|json| serde_json::from_str::<Vec<EndpointView>>(json).ok())
            .unwrap_or_default();
        let gateway_status = status_str.and_then(|s| parse_status(&s));
        Ok(PlatformView {
            run_id: request.run_id.clone(),
            sandbox_id: request.sandbox_id.clone(),
            state: request.state,
            prepare_operation_id: request.prepare_operation_id,
            gateway_status,
            endpoints,
            last_error: request.last_error,
            updated_at: request.updated_at,
        })
    }

    /// 记录一次准备请求（insert or replace，保留字段由调用方读改写维护）。
    pub(crate) fn record_request(&self, record: &RequestRecord) -> Result<(), StoreError> {
        self.execute(|conn| {
            conn.execute(
                "INSERT INTO sandbox_links (
                     run_id, sandbox_id, prepare_operation_id, state, spec_json,
                     gateway_summary, last_error, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(run_id) DO UPDATE SET
                     sandbox_id = excluded.sandbox_id,
                     prepare_operation_id = excluded.prepare_operation_id,
                     state = excluded.state,
                     spec_json = excluded.spec_json,
                     gateway_summary = excluded.gateway_summary,
                     last_error = excluded.last_error,
                     updated_at = excluded.updated_at",
                params![
                    record.run_id,
                    record.sandbox_id,
                    record.prepare_operation_id,
                    record.state.as_str(),
                    record.spec_json,
                    record.gateway_summary,
                    record.last_error,
                    record.updated_at,
                ],
            )
            .map_err(StoreError::from)?;
            Ok(())
        })
    }

    /// 按运行标识取请求记录；不存在返回 `Ok(None)`。
    pub fn request_record(&self, run_id: &str) -> Result<Option<RequestRecord>, StoreError> {
        self.execute(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT run_id, sandbox_id, prepare_operation_id, state, spec_json,
                            gateway_summary, last_error, updated_at
                     FROM sandbox_links WHERE run_id = ?1",
                )
                .map_err(StoreError::from)?;
            let mut rows = stmt.query(params![run_id]).map_err(StoreError::from)?;
            match rows.next().map_err(StoreError::from)? {
                Some(row) => Ok(Some(row_to_request(row)?)),
                None => Ok(None),
            }
        })
    }

    /// 更新本地状态与最近错误，不改动请求身份、规格与平台视图。
    pub(crate) fn update_state(
        &self,
        run_id: &str,
        state: DomainSandboxState,
        last_error: Option<String>,
    ) -> Result<(), StoreError> {
        self.execute(|conn| {
            conn.execute(
                "UPDATE sandbox_links SET state = ?2, last_error = ?3, updated_at = ?4
                 WHERE run_id = ?1",
                params![run_id, state.as_str(), last_error, super::now_rfc3339()],
            )
            .map_err(StoreError::from)?;
            Ok(())
        })
    }

    /// 已确认关联：沙箱标识就位且本地状态 Ready。
    pub fn confirmed_link(&self, run_id: &str) -> Result<Option<(String, String)>, StoreError> {
        Ok(self
            .request_record(run_id)?
            .filter(|r| r.state == DomainSandboxState::Ready && r.sandbox_id.is_some())
            .map(|r| (r.sandbox_id.expect("状态 Ready 保证沙箱标识存在"), r.spec_json)))
    }

    /// 平台状态存储文本（小写，与契约 status 字段一致）。
    fn status_text(status: GatewaySandboxStatus) -> &'static str {
        match status {
            GatewaySandboxStatus::Preparing => "preparing",
            GatewaySandboxStatus::Running => "running",
            GatewaySandboxStatus::Stopped => "stopped",
            GatewaySandboxStatus::Deleting => "deleting",
            GatewaySandboxStatus::Error => "error",
        }
    }

    /// 更新平台视图快照（状态与端点 JSON）。
    pub(crate) fn update_gateway_snapshot(
        &self,
        run_id: &str,
        status: Option<GatewaySandboxStatus>,
        endpoints_json: Option<String>,
    ) -> Result<(), StoreError> {
        self.execute(|conn| {
            conn.execute(
                "UPDATE sandbox_links SET gateway_status = ?2, endpoints_json = ?3
                 WHERE run_id = ?1",
                params![run_id, status.map(Self::status_text), endpoints_json],
            )
            .map_err(StoreError::from)?;
            Ok(())
        })
    }

    /// 平台视图：本地关联加最近平台快照；无关联返回 None（NotFound 判定）。
    pub fn platform_view(&self, run_id: &str) -> Result<Option<PlatformView>, StoreError> {
        self.execute(|conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT run_id, sandbox_id, prepare_operation_id, state, spec_json,
                            gateway_summary, last_error, updated_at,
                            gateway_status, endpoints_json
                     FROM sandbox_links WHERE run_id = ?1",
                )
                .map_err(StoreError::from)?;
            let mut rows = stmt.query(params![run_id]).map_err(StoreError::from)?;
            match rows.next().map_err(StoreError::from)? {
                Some(row) => Self::row_to_view(row).map(Some).map_err(StoreError::from),
                None => Ok(None),
            }
        })
    }

    /// 释放确认：本地状态 Released，保留关联记录供幂等再请求。
    pub(crate) fn record_released(&self, run_id: &str) -> Result<(), StoreError> {
        self.update_state(run_id, DomainSandboxState::Released, None)
    }

    /// 登记通道准入。同一运行重复接入是幂等更新（准入时间刷新）。
    pub(crate) fn record_grant(
        &self,
        run_id: &str,
        endpoint: Option<&str>,
    ) -> Result<(), StoreError> {
        self.execute(|conn| {
            conn.execute(
                "INSERT INTO access_grants (run_id, endpoint, granted_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(run_id) DO UPDATE SET
                     endpoint = excluded.endpoint,
                     granted_at = excluded.granted_at",
                params![run_id, endpoint, super::now_rfc3339()],
            )
            .map_err(StoreError::from)?;
            Ok(())
        })
    }

    /// 查询通道准入；未登记返回 `Ok(None)`，已登记返回准入端点（可为 None）。
    pub fn access_grant(&self, run_id: &str) -> Result<Option<String>, StoreError> {
        self.execute(|conn| {
            let mut stmt = conn
                .prepare_cached("SELECT endpoint FROM access_grants WHERE run_id = ?1")
                .map_err(StoreError::from)?;
            let mut rows = stmt.query(params![run_id]).map_err(StoreError::from)?;
            match rows.next().map_err(StoreError::from)? {
                Some(row) => row.get::<_, Option<String>>(0).map_err(StoreError::from),
                None => Ok(None),
            }
        })
    }

    /// 回收通道准入记录（释放后清空）。
    pub(crate) fn clear_access_grant(&self, run_id: &str) -> Result<(), StoreError> {
        self.execute(|conn| {
            conn.execute(
                "DELETE FROM access_grants WHERE run_id = ?1",
                params![run_id],
            )
            .map_err(StoreError::from)?;
            Ok(())
        })
    }
}

/// 平台侧状态文本转枚举；未知值返回 None（保留先前快照语义由调用方处理）。
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

/// 行映射辅助（`Row` 生命周期限定在查询作用域内；宽行多出的列按名读取，
/// 不影响本映射）。
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
