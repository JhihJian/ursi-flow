//! workflows 测试支撑：角色网关替身与定义夹具。
//!
//! 仅测试编译（`#[cfg(test)]` 门控），不属于交付面。
//! 替身线程安全（Mutex/原子量），满足 `RoleReferenceGateway` 的
//! Send + Sync 约束，可注入 [`WorkflowStore`]。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::domain::{NodeType, WorkflowDefinition, WorkflowNode};

use super::{GatewayError, RoleReferenceGateway};

/// 计数网关替身：记录每次调用（角色 ID 与操作），登记表内存可变，
/// 支持 exists / register / unregister 三类故障注入。
pub(crate) struct RecordingGateway {
    roles: HashSet<String>,
    calls: Mutex<Vec<(String, &'static str)>>,
    refs: Mutex<HashMap<String, HashSet<String>>>,
    fail_exists: AtomicBool,
    fail_register: AtomicBool,
    fail_unregister: AtomicBool,
}

impl RecordingGateway {
    pub(crate) fn new(roles: &[&str]) -> Self {
        Self {
            roles: roles.iter().map(|s| s.to_string()).collect(),
            calls: Mutex::new(Vec::new()),
            refs: Mutex::new(HashMap::new()),
            fail_exists: AtomicBool::new(false),
            fail_register: AtomicBool::new(false),
            fail_unregister: AtomicBool::new(false),
        }
    }

    /// 注入故障：`exists` 返回 `GatewayError`（查询不可用）。
    pub(crate) fn fail_exists(&self) {
        self.fail_exists.store(true, Ordering::SeqCst);
    }

    /// 累计调用次数（所有操作）。
    pub(crate) fn total_calls(&self) -> usize {
        self.calls.lock().unwrap().len()
    }

    /// 登记表当前 (workflow, role) 集合。
    pub(crate) fn registered(&self) -> HashSet<(String, String)> {
        self.refs
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(wf, roles)| roles.iter().map(move |role| (wf.clone(), role.clone())))
            .collect()
    }

    /// 调用记录快照：(角色, 操作) 序列。
    pub(crate) fn call_log(&self) -> Vec<(String, &'static str)> {
        self.calls.lock().unwrap().clone()
    }

    fn record(&self, role_id: &str, op: &'static str) {
        self.calls
            .lock()
            .unwrap()
            .push((role_id.to_string(), op));
    }

    fn failing(flag: &AtomicBool) -> bool {
        flag.load(Ordering::SeqCst)
    }
}

impl RoleReferenceGateway for RecordingGateway {
    fn exists(&self, role_id: &str) -> Result<bool, GatewayError> {
        self.record(role_id, "exists");
        if Self::failing(&self.fail_exists) {
            return Err(GatewayError::Unavailable("注入故障".into()));
        }
        Ok(self.roles.contains(role_id))
    }

    fn register_ref(
        &self,
        _tx: &rusqlite::Connection,
        role_id: &str,
        workflow_id: &str,
    ) -> Result<(), GatewayError> {
        self.record(role_id, "register");
        if Self::failing(&self.fail_register) {
            return Err(GatewayError::Unavailable("注入故障".into()));
        }
        self.refs
            .lock()
            .unwrap()
            .entry(workflow_id.to_string())
            .or_default()
            .insert(role_id.to_string());
        Ok(())
    }

    fn unregister_ref(
        &self,
        _tx: &rusqlite::Connection,
        role_id: &str,
        workflow_id: &str,
    ) -> Result<(), GatewayError> {
        self.record(role_id, "unregister");
        if Self::failing(&self.fail_unregister) {
            return Err(GatewayError::Unavailable("注入故障".into()));
        }
        if let Some(set) = self.refs.lock().unwrap().get_mut(workflow_id) {
            set.remove(role_id);
        }
        Ok(())
    }

    fn list_refs(
        &self,
        _tx: &rusqlite::Connection,
        workflow_id: &str,
    ) -> Result<Vec<String>, GatewayError> {
        Ok(self
            .refs
            .lock()
            .unwrap()
            .get(workflow_id)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default())
    }
}

/// 空节点骨架（按需补字段）。
pub(crate) fn bare(id: &str, node_type: NodeType) -> WorkflowNode {
    WorkflowNode {
        id: id.to_string(),
        name: id.to_string(),
        node_type,
        role_id: None,
        script: None,
        script_language: None,
        reject_to: None,
        max_attempts: 0,
        max_reworks: 0,
        artifact_outputs: Vec::new(),
        position: Default::default(),
    }
}

/// 合法 agent 节点（引用 role-a）。
pub(crate) fn agent(id: &str) -> WorkflowNode {
    let mut n = bare(id, NodeType::Agent);
    n.role_id = Some("role-a".into());
    n
}

pub(crate) fn approval(id: &str) -> WorkflowNode {
    bare(id, NodeType::Approval)
}

pub(crate) fn script(id: &str, body: &str) -> WorkflowNode {
    let mut n = bare(id, NodeType::Script);
    n.script = Some(body.into());
    n
}

pub(crate) fn edge(source: &str, target: &str) -> crate::domain::WorkflowEdge {
    crate::domain::WorkflowEdge {
        source: source.to_string(),
        target: target.to_string(),
    }
}

pub(crate) fn def(
    id: &str,
    nodes: Vec<WorkflowNode>,
    edges: Vec<crate::domain::WorkflowEdge>,
) -> WorkflowDefinition {
    WorkflowDefinition {
        id: id.into(),
        name: "demo".into(),
        nodes,
        edges,
    }
}

/// SQLite 落库版替身：登记表写在该 SQLite 数据库的 `workflow_role_refs`
/// 表（经传入事务连接执行），事务回滚时登记随之回退，行为与真实 roles
/// 的「登记写入调用方事务」对齐。exists 语义与 RecordingGateway 相同。
pub(crate) struct SqliteGateway {
    exists: AtomicBool,
    fail_register: AtomicBool,
    fail_unregister: AtomicBool,
}

impl SqliteGateway {
    /// 创建替身（字段对 tests 模块可见）。
    pub(crate) fn new() -> Self {
        Self {
            exists: AtomicBool::new(false),
            fail_register: AtomicBool::new(false),
            fail_unregister: AtomicBool::new(false),
        }
    }

    /// 在该连接上建登记表（测试库自持 schema，与 workflows 表共存）。
    pub(crate) fn prepare(conn: &rusqlite::Connection) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS workflow_role_refs (
                 role_id     TEXT NOT NULL,
                 workflow_id TEXT NOT NULL,
                 UNIQUE(role_id, workflow_id)
             );",
        )
        .expect("建登记表");
    }

    /// 注入故障：`register_ref` 返回 `GatewayError`。
    pub(crate) fn fail_register(&self) {
        self.fail_register.store(true, Ordering::SeqCst);
    }

    /// 注入故障：`unregister_ref` 返回 `GatewayError`。
    pub(crate) fn fail_unregister(&self) {
        self.fail_unregister.store(true, Ordering::SeqCst);
    }

    /// 关闭全部故障注入。
    pub(crate) fn reset_failures(&self) {
        self.exists.store(false, Ordering::SeqCst);
        self.fail_register.store(false, Ordering::SeqCst);
        self.fail_unregister.store(false, Ordering::SeqCst);
    }
}

impl RoleReferenceGateway for SqliteGateway {
    fn exists(&self, role_id: &str) -> Result<bool, GatewayError> {
        if self.exists.load(Ordering::SeqCst) {
            return Err(GatewayError::Unavailable("注入故障".into()));
        }
        // 测试库无角色表，存在性由调用方约定：role-a / role-b 存在。
        Ok(matches!(role_id, "role-a" | "role-b"))
    }

    fn register_ref(
        &self,
        tx: &rusqlite::Connection,
        role_id: &str,
        workflow_id: &str,
    ) -> Result<(), GatewayError> {
        if self.fail_register.load(Ordering::SeqCst) {
            return Err(GatewayError::Unavailable("注入故障".into()));
        }
        tx.execute(
            "INSERT INTO workflow_role_refs (role_id, workflow_id) VALUES (?1, ?2)
             ON CONFLICT(role_id, workflow_id) DO NOTHING",
            [role_id, workflow_id],
        )
        .map_err(|e| GatewayError::Unavailable(e.to_string()))?;
        Ok(())
    }

    fn unregister_ref(
        &self,
        tx: &rusqlite::Connection,
        role_id: &str,
        workflow_id: &str,
    ) -> Result<(), GatewayError> {
        if self.fail_unregister.load(Ordering::SeqCst) {
            return Err(GatewayError::Unavailable("注入故障".into()));
        }
        tx.execute(
            "DELETE FROM workflow_role_refs WHERE role_id = ?1 AND workflow_id = ?2",
            [role_id, workflow_id],
        )
        .map_err(|e| GatewayError::Unavailable(e.to_string()))?;
        Ok(())
    }

    fn list_refs(
        &self,
        tx: &rusqlite::Connection,
        workflow_id: &str,
    ) -> Result<Vec<String>, GatewayError> {
        let mut stmt = tx
            .prepare("SELECT role_id FROM workflow_role_refs WHERE workflow_id = ?1")
            .map_err(|e| GatewayError::Unavailable(e.to_string()))?;
        let rows = stmt
            .query_map([workflow_id], |r| r.get::<_, String>(0))
            .map_err(|e| GatewayError::Unavailable(e.to_string()))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| GatewayError::Unavailable(e.to_string()))?;
        Ok(rows)
    }
}
