//! 流程定义存储：storage `Database` 直连 SQLite，自管本域表。
//!
//! 本域拥有 `workflows` 表（业务表与 repository 归业务域，见 storage SPEC），
//! 表结构经 [`WORKFLOW_MIGRATIONS`] 提供给 app 登记；独立测试直接传给
//! [`WorkflowStore::open`]。definition 以 serde_json 序列化
//! [`WorkflowDefinition`] 存储，读回即完整图结构。
//!
//! 一致性顺序（文档化契约，见各方法注释）：保存与引用登记在同一事务
//! （storage `Transaction`，IMMEDIATE + 退出自动回滚）内完成，顺序固定为
//! 「先写定义，再经网关在事务连接上变更登记」。角色存在性检查在事务外
//! 先行执行；事务内的最终一致性由 roles 的删除检查与共享事务约束保证
//! （DESIGN「一致性归属」：并发删除角色与保存引用只有合法的串行结果）。

use std::sync::Arc;

use rusqlite::Connection;

use crate::storage::{Database, Migration};

use super::{
    validate_definition, now_rfc3339, RoleReferenceGateway, WorkflowDefinition, WorkflowError,
};

/// workflows 域迁移（登记到 app 的统一迁移列表，顺序只可追加）。
pub const WORKFLOW_MIGRATIONS: &[Migration] = &[Migration::new(
    "workflows_create",
    "CREATE TABLE workflows (
        id              TEXT PRIMARY KEY,
        definition_json TEXT NOT NULL,
        updated_at      TEXT NOT NULL
    );",
)];

/// 流程定义存储。网关注入本域依赖的角色引用接口（roles 实现）。
pub struct WorkflowStore {
    db: Database,
    gateway: Arc<dyn RoleReferenceGateway>,
}

impl WorkflowStore {
    /// 打开存储并应用本域迁移。
    pub fn open(
        path: impl AsRef<std::path::Path>,
        gateway: Arc<dyn RoleReferenceGateway>,
    ) -> Result<Self, WorkflowError> {
        let db = Database::open(path, WORKFLOW_MIGRATIONS)
            .map_err(|err| WorkflowError::Storage(err.to_string()))?;
        Ok(Self { db, gateway })
    }

    /// 创建流程定义：纯结构校验 → 角色存在性检查 → 事务内保存并登记。
    ///
    /// 事务顺序（文档化契约）：先保存定义，再对每个引用的角色调用
    /// `register_ref`。两步同事务提交，任一步失败整体回滚，存储不出现
    /// 未经校验的定义，也不会残留半份登记。
    pub fn create(&self, def: WorkflowDefinition) -> Result<WorkflowDefinition, WorkflowError> {
        validate_definition(&def)?;
        self.check_roles(&def)?;
        let role_ids = collect_role_ids(&def);
        let mut tx = self.db.begin()?;
        save_definition(tx.conn(), &def)?;
        for role_id in &role_ids {
            self.gateway.register_ref(tx.conn(), role_id, &def.id)?;
        }
        tx.commit()?;
        Ok(def)
    }

    /// 列出全部流程定义（按更新时间排序）。
    pub fn list(&self) -> Result<Vec<WorkflowDefinition>, WorkflowError> {
        let jsons = self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT definition_json FROM workflows ORDER BY updated_at ASC, id ASC",
            )?;
            stmt.query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<String>>>()
        })?;
        jsons
            .iter()
            .map(|json| {
                serde_json::from_str(json).map_err(|e| WorkflowError::Storage(e.to_string()))
            })
            .collect()
    }

    /// 读取单个流程定义；未知 id 返回 `NotFound`。
    /// 返回克隆值：调用方持有独立副本，后续更新不影响旧读取结果。
    pub fn get(&self, id: &str) -> Result<WorkflowDefinition, WorkflowError> {
        let conn = &mut *self.db.lock_conn();
        load_definition(conn, id)
    }

    /// 更新流程定义：与 create 相同的校验路径；不存在返回 `NotFound`。
    ///
    /// 事务顺序（文档化契约）：保存新定义 → 事务内查旧登记 → 解除不再
    /// 使用的引用 → 登记新增引用。任一步失败整体回滚，已保存定义不变；
    /// 纯校验与角色存在性检查在事务外完成，失败不进入事务。
    pub fn update(&self, def: WorkflowDefinition) -> Result<WorkflowDefinition, WorkflowError> {
        validate_definition(&def)?;
        self.check_roles(&def)?;
        let role_ids = collect_role_ids(&def);
        let mut tx = self.db.begin()?;
        if !definition_exists(tx.conn(), &def.id)? {
            return Err(WorkflowError::NotFound(def.id));
        }
        save_definition(tx.conn(), &def)?;
        sync_role_refs(
            self.gateway.as_ref(),
            tx.conn(),
            &def.id,
            &role_ids,
        )?;
        tx.commit()?;
        Ok(def)
    }

    /// 删除流程定义：事务内移除定义并解除全部登记。
    ///
    /// 不存在语义（文档化契约）：未知 id 与重复删除都返回 `NotFound`
    /// （选择明确不存在而非静默幂等，调用方可区分「已删除」与「从未
    /// 存在」的误用）。
    pub fn delete(&self, id: &str) -> Result<(), WorkflowError> {
        let mut tx = self.db.begin()?;
        let n = tx
            .conn()
            .execute("DELETE FROM workflows WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(WorkflowError::NotFound(id.to_string()));
        }
        for role_id in self.gateway.list_refs(tx.conn(), id)? {
            self.gateway.unregister_ref(tx.conn(), &role_id, id)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn path(&self) -> &std::path::Path {
        self.db.path()
    }

    /// 连接句柄（测试与联调读取本域表；事务内操作勿用此句柄）。
    #[cfg(test)]
    pub(crate) fn conn(&self) -> std::sync::Arc<std::sync::Mutex<rusqlite::Connection>> {
        self.db.conn()
    }

    /// 角色存在性检查（事务外）：逐个 agent 节点的 role_id 调用网关，
    /// 同一角色去重只查一次。「确定不存在」与「查询失败」映射为不同
    /// 错误变体并定位节点与角色。
    fn check_roles(&self, def: &WorkflowDefinition) -> Result<(), WorkflowError> {
        for role_id in collect_role_ids(def) {
            // 缺少 role_id 的节点已在校验阶段拒绝，此处按出现顺序回查定位。
            let node_id = def
                .nodes
                .iter()
                .find(|n| n.role_id.as_deref() == Some(role_id.as_str()))
                .map(|n| n.id.clone())
                .unwrap_or_default();
            match self.gateway.exists(&role_id) {
                Ok(true) => {}
                Ok(false) => {
                    return Err(WorkflowError::RoleMissing {
                        node_id,
                        role_id,
                    })
                }
                Err(err) => return Err(WorkflowError::RoleGateway(err)),
            }
        }
        Ok(())
    }
}

/// 收集定义引用的全部角色 ID（去重，保持出现顺序）。
fn collect_role_ids(def: &WorkflowDefinition) -> Vec<String> {
    let mut ids = Vec::new();
    for node in &def.nodes {
        if let Some(role_id) = node.role_id.as_deref() {
            if !ids.iter().any(|id| id == role_id) {
                ids.push(role_id.to_string());
            }
        }
    }
    ids
}

/// 保存定义（UPSERT）。定义以 serde_json 完整序列化落库。
fn save_definition(conn: &Connection, def: &WorkflowDefinition) -> Result<(), WorkflowError> {
    let json = serde_json::to_string(def).map_err(|e| WorkflowError::Storage(e.to_string()))?;
    conn.execute(
        "INSERT INTO workflows (id, definition_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE
         SET definition_json = excluded.definition_json, updated_at = excluded.updated_at",
        rusqlite::params![def.id, json, now_rfc3339()],
    )?;
    Ok(())
}

/// 读取定义；未知 id 映射为 `NotFound`，其余存储错误原样上抛。
fn load_definition(conn: &Connection, id: &str) -> Result<WorkflowDefinition, WorkflowError> {
    let json = match conn.query_row(
        "SELECT definition_json FROM workflows WHERE id = ?1",
        [id],
        |row| row.get::<_, String>(0),
    ) {
        Ok(json) => json,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return Err(WorkflowError::NotFound(id.to_string()))
        }
        Err(err) => return Err(err.into()),
    };
    serde_json::from_str(&json).map_err(|e| WorkflowError::Storage(e.to_string()))
}

/// 把登记集合同步到目标集合：解除不在目标中的旧登记，登记缺失的新引用。
/// 登记接口幂等；同事务内先解除后登记，外部看不到中间状态。
fn sync_role_refs(
    gateway: &dyn RoleReferenceGateway,
    conn: &Connection,
    workflow_id: &str,
    target: &[String],
) -> Result<(), WorkflowError> {
    let current = gateway.list_refs(conn, workflow_id)?;
    for role_id in &current {
        if !target.contains(role_id) {
            gateway.unregister_ref(conn, role_id, workflow_id)?;
        }
    }
    for role_id in target {
        if !current.contains(role_id) {
            gateway.register_ref(conn, role_id, workflow_id)?;
        }
    }
    Ok(())
}

/// 定义是否存在（事务内存在性检查，SELECT EXISTS）。
fn definition_exists(conn: &Connection, id: &str) -> Result<bool, WorkflowError> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflows WHERE id = ?1)",
        [id],
        |r| r.get(0),
    )?;
    Ok(exists)
}
