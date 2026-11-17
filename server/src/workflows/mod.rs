//! 流程定义管理：图结构校验、定义 CRUD 与角色引用一致性。
//!
//! 本模块拥有工作流定义的编辑期生命周期：定义创建、查询、更新、删除、
//! 纯结构校验与角色引用校验；运行快照、节点调度和运行状态归 runs
//! （DESIGN「一致性归属」）。图模型与 DAG 规则复用 ursi_domain。
//!
//! 与 roles 的一致性约束：角色引用登记归 roles 所有，本模块不接触其表
//! 结构，只通过 [`RoleReferenceGateway`] 操作登记。保存、更新或删除定义时，
//! 引用登记变更与定义写入在同一 SQLite 事务（storage `Transaction`）中
//! 提交，任一步失败整体回滚；与角色删除的并发约束由同一事务序列化保证。
//!
//! 相对原骨架的变化：原 `WorkflowRepository`（put_workflow/get_workflow，
//! 基于 `StoreError` 的异步仓库）重建为 [`store::WorkflowStore`]——完整本域
//! 接口（create/list/get/update/delete，含事务内引用登记一致性），存储经
//! storage `Database` 自管 `workflows` 表。rusqlite 为同步接口，本域接口
//! 由此改为同步方法，异步调用方按 storage 约定以 `block_in_place` 包裹；
//! 跨域角色访问收敛为同步 [`RoleReferenceGateway`]，roles 将提供真实实现。

pub(crate) mod store;

#[cfg(test)]
pub(crate) mod testing;
use ursi_domain::WorkflowDefinition;

pub use store::{WorkflowStore, WORKFLOW_MIGRATIONS};

/// 角色网关错误：roles 侧查询或登记操作失败（服务不可用、存储异常等）。
/// 与「角色确定不存在」（`exists` 返回 `false`）是可区分的语义。
#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    #[error("角色服务不可用：{0}")]
    Unavailable(String),
}

/// workflows 依赖的角色引用网关（本模块定义，roles 提供真实实现）。
///
/// 与 roles SPEC「引用登记与删除约束」的接口语义对齐：
/// - `exists` 对应 roles 的角色存在性检查，在事务外调用；
/// - `register_ref` / `unregister_ref` / `list_refs` 对应登记、解除登记与
///   按引用方查询。调用方传入 storage 事务的连接，使登记变更与流程定义
///   保存共同提交（roles SPEC：「调用方传入 storage 事务」）；
/// - 登记以引用方标识（workflow_id）定位，重复登记保持幂等。
pub trait RoleReferenceGateway: Send + Sync {
    /// 角色是否存在。
    fn exists(&self, role_id: &str) -> Result<bool, GatewayError>;
    /// 在事务连接上登记 (workflow_id -> role_id) 引用；重复登记幂等。
    fn register_ref(
        &self,
        tx: &rusqlite::Connection,
        role_id: &str,
        workflow_id: &str,
    ) -> Result<(), GatewayError>;
    /// 在事务连接上解除指定引用；未登记时同样成功（幂等）。
    fn unregister_ref(
        &self,
        tx: &rusqlite::Connection,
        role_id: &str,
        workflow_id: &str,
    ) -> Result<(), GatewayError>;
    /// 查询某流程当前登记的全部角色引用。
    fn list_refs(
        &self,
        tx: &rusqlite::Connection,
        workflow_id: &str,
    ) -> Result<Vec<String>, GatewayError>;
}

/// 本域错误。结构校验错误来自 ursi_domain，已带节点定位。
#[derive(Debug, thiserror::Error)]
pub enum WorkflowError {
    #[error("流程 {0} 不存在")]
    NotFound(String),
    #[error("流程 {0} 已存在")]
    AlreadyExists(String),
    /// 纯结构校验失败；source 为 domain 错误，含具体节点定位。
    #[error("定义结构校验失败：{0}")]
    Invalid(#[from] ursi_domain::WorkflowError),
    /// 角色确定不存在，定位引用它的节点与角色。
    #[error("节点 {node_id} 引用的角色不存在：{role_id}")]
    RoleMissing {
        node_id: String,
        role_id: String,
    },
    /// 角色网关调用失败（查询、登记或解除登记），与「确定缺失」可区分。
    #[error("角色网关调用失败：{0}")]
    RoleGateway(#[from] GatewayError),
    #[error("存储错误：{0}")]
    Storage(String),
}

impl From<rusqlite::Error> for WorkflowError {
    fn from(err: rusqlite::Error) -> Self {
        WorkflowError::Storage(err.to_string())
    }
}

impl From<crate::storage::StoreError> for WorkflowError {
    fn from(err: crate::storage::StoreError) -> Self {
        match err {
            crate::storage::StoreError::NotFound(id) => WorkflowError::NotFound(id),
            crate::storage::StoreError::StaleGeneration(msg)
            | crate::storage::StoreError::Storage(msg) => WorkflowError::Storage(msg),
        }
    }
}

/// 纯结构校验入口：仅依据输入定义执行字段、节点标识、边端点、节点类型
/// 与 DAG 无环检查。不访问存储与角色网关，可独立于数据库执行。
/// 错误来自 ursi_domain，携带节点定位。
pub fn validate_definition(wf: &WorkflowDefinition) -> Result<(), WorkflowError> {
    ursi_domain::validate_workflow(wf)?;
    Ok(())
}

/// 当前环境无 chrono 依赖，手工构造 RFC 3339 UTC 时间（秒级精度），
/// 用于 `updated_at` 排序。实现与 connections::store 保持一致。
pub(crate) fn now_rfc3339() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时钟早于 Unix 纪元");
    let total = now.as_secs();
    let days = total / 86_400;
    let secs_of_day = total % 86_400;
    let (h, m, s) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    // civ_days 算法（Howard Hinnant）：1970-01-01 起的天数转 y-m-d。
    let z = (days + 719_468) as i64;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

#[cfg(test)]
mod store_tests;

#[cfg(test)]
mod tests;
