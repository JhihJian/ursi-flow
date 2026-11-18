//! 定义 CRUD、存储、角色引用校验与交付测试（SPEC 第 1、2、4、5 组验收）。

use std::sync::Arc;

use super::testing::{agent, approval, def, edge, script, RecordingGateway, SqliteGateway};
use super::{WorkflowDefinition, WorkflowError, WorkflowStore};
use crate::domain::{NodeType, Position};

/// 内存计数替身版：验证调用契约与登记结果（登记语义与回滚细节由
/// SqliteGateway 版测试覆盖）。
fn store() -> (WorkflowStore, Arc<RecordingGateway>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("wf.db");
    std::mem::forget(dir);
    let gw = Arc::new(RecordingGateway::new(&["role-a"]));
    let store = WorkflowStore::open(&path, gw.clone()).unwrap();
    (store, gw)
}

/// SQLite 落库替身版：登记写真实 SQLite（独立连接句柄便于断言），
/// 回滚语义与真实 roles 一致。
fn sqlite_store() -> (WorkflowStore, Arc<SqliteGateway>, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("wf.db");
    std::mem::forget(dir);
    // 先建登记表：WorkflowStore::open 会应用迁移，之后补建 refs 表。
    let gw = Arc::new(SqliteGateway::new());
    let store = WorkflowStore::open(&path, gw.clone()).unwrap();
    SqliteGateway::prepare(&store.conn().lock().unwrap());
    (store, gw, path)
}

/// 组装 SPEC「图定义创建与查询」的样例：agent + script + approval 的 DAG。
fn full_definition(id: &str) -> WorkflowDefinition {
    let mut wf = def(id, vec![agent("A"), script("S", "echo done"), approval("R")],
        vec![edge("A", "S"), edge("S", "R")]);
    wf.nodes[0].artifact_outputs = vec![crate::domain::ArtifactContract {
        name: "报告".into(),
        path: "out/report.md".into(),
        required: true,
        media_type: Some("text/markdown".into()),
    }];
    wf.nodes[0].position = Position { x: 12.5, y: -3.0 };
    wf
}

/// SPEC「图定义创建与查询」：提交包含 agent、script、approval 节点的合法
/// DAG，创建成功，详情完整返回节点与边。
#[test]
fn 创建合法定义后详情完整返回() {
    let (store, _gw) = store();
    let wf = full_definition("wf-full");
    let created = store.create(wf.clone()).unwrap();

    assert_eq!(created.id, "wf-full");
    let got = store.get("wf-full").unwrap();
    assert_eq!(got.nodes.len(), 3);
    assert_eq!(got.edges.len(), 2);
    assert_ser_eq_msg(&got, &wf, "详情必须与提交内容一致");
}

/// SPEC「图定义创建与查询」：创建多个流程后列表能区分各自标识，
/// 查询未知标识返回明确的不存在结果。
#[test]
fn 列表区分标识且未知标识返回_not_found() {
    let (store, _gw) = store();
    store
        .create(def("wf-a", vec![approval("N1")], vec![]))
        .unwrap();
    store
        .create(def("wf-b", vec![approval("N2")], vec![]))
        .unwrap();

    let list = store.list().unwrap();
    let mut ids: Vec<&str> = list.iter().map(|wf| wf.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec!["wf-a", "wf-b"]);

    assert!(matches!(
        store.get("wf-missing"),
        Err(WorkflowError::NotFound(ref id)) if id == "wf-missing"
    ));
}

/// SPEC「图定义创建与查询」：重新打开临时 SQLite 后，读取的定义及节点
/// 配置与提交内容一致。
#[test]
fn 重开_sqlite_读回一致() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("wf.db");
    let wf = full_definition("wf-persist");
    {
        let gw = Arc::new(SqliteGateway::new());
        let store = WorkflowStore::open(&path, gw).unwrap();
        SqliteGateway::prepare(&store.conn().lock().unwrap());
        store.create(wf.clone()).unwrap();
    }
    let store2 = WorkflowStore::open(&path, Arc::new(SqliteGateway::new())).unwrap();
    SqliteGateway::prepare(&store2.conn().lock().unwrap());
    assert_ser_eq(&store2.get("wf-persist").unwrap(), &wf);
    assert_ser_eq_list(&store2.list().unwrap(), &[wf]);
}

/// SPEC「图定义创建与查询」+「角色引用校验」：所有角色存在时合法定义
/// 可以保存；多个节点引用同一角色时定义完整保留，登记去重。
#[test]
fn 多节点引用同一角色完整保存且登记幂等() {
    let (store, gw) = store();
    let wf = def(
        "wf-shared-role",
        vec![agent("A1"), agent("A2"), approval("R")],
        vec![edge("A1", "A2"), edge("A2", "R")],
    );
    store.create(wf.clone()).unwrap();

    assert_eq!(
        gw.registered(),
        [("wf-shared-role".to_string(), "role-a".to_string())]
            .into_iter()
            .collect(),
        "同一角色多次引用只登记一次"
    );
    assert_ser_eq(&store.get("wf-shared-role").unwrap(), &wf);
}

/// SPEC「纯结构校验」：校验失败的创建不改变已保存定义（创建路径，
/// 不产生新定义与登记）。
#[test]
fn 非法创建不产生存储痕迹() {
    let (store, gw) = store();
    store
        .create(def("wf-ok", vec![approval("N1")], vec![]))
        .unwrap();

    // 缺边端点且带缺失角色引用的定义：结构校验失败在角色检查之前。
    let bad = def("wf-bad", vec![agent("A")], vec![edge("A", "GHOST")]);
    assert!(store.create(bad).is_err());
    assert_eq!(store.list().unwrap().len(), 1);
    assert!(!gw.registered().iter().any(|(wf, _)| wf == "wf-bad"),
        "失败创建不得产生登记");
}

/// SPEC「角色引用校验」：任一角色缺失时保存失败，错误定位对应节点和
/// 角色，流程与引用登记均保持原值。
#[test]
fn 角色缺失保存失败且定位节点与角色() {
    let (store, gw) = store();
    let mut wf = full_definition("wf-missing-role");
    wf.nodes[2].node_type = NodeType::Agent;
    wf.nodes[2].role_id = Some("role-ghost".into());

    let err = store.create(wf).unwrap_err();
    match err {
        WorkflowError::RoleMissing { node_id, role_id } => {
            assert_eq!(node_id, "R");
            assert_eq!(role_id, "role-ghost");
        }
        other => panic!("期望角色缺失错误，实际 {other:?}"),
    }
    assert!(
        store.get("wf-missing-role").is_err(),
        "失败后存储不得出现新定义"
    );
    assert!(!gw.registered().iter().any(|(w, _)| w == "wf-missing-role"));
}

/// SPEC「角色引用校验」：角色查询不可用时返回查询失败（与确定缺失
/// 可区分的错误变体），存储中不出现未经角色校验的新定义。
#[test]
fn 网关查询失败返回独立错误变体() {
    let (store, gw) = store();
    gw.fail_exists();

    let err = store
        .create(def("wf-gw-down", vec![agent("A")], vec![]))
        .unwrap_err();
    assert!(
        matches!(err, WorkflowError::RoleGateway(_)),
        "查询失败必须映射为 RoleGateway，实际 {err:?}"
    );
    assert!(store.get("wf-gw-down").is_err(), "存储不得出现未校验定义");
    assert!(gw.registered().is_empty());
}

/// SPEC「定义更新、删除与引用一致性」：将角色引用从 A 改为 B 后，流程
/// 详情只含 B，A 的对应登记解除且 B 的登记建立。
#[test]
fn 更新后详情反映新引用() {
    let (store, _gw, _path) = sqlite_store();
    let mut wf = full_definition("wf-switch");
    store.create(wf.clone()).unwrap();

    for node in &mut wf.nodes {
        if node.node_type == NodeType::Agent {
            node.role_id = Some("role-b".into());
        }
    }
    let updated = store.update(wf.clone()).unwrap();
    assert_ser_eq(&updated, &wf);
    assert_ser_eq(&store.get("wf-switch").unwrap(), &wf);
    assert!(updated.nodes.iter().all(|n| n.node_type != NodeType::Agent
        || n.role_id.as_deref() == Some("role-b")));
    // 登记随引用切换（SQLite 落库替身可查）。
    assert_eq!(gw_refs(&store, "wf-switch"), vec!["role-b"]);
}

/// SPEC「定义更新、删除与引用一致性」：「校验失败的更新不改变已保存
/// 定义」（结构非法与角色缺失两条路径），事务整体回滚。
#[test]
fn 失败更新保留原定义与登记() {
    let (store, gw, _path) = sqlite_store();
    let _ = &gw;
    let original = full_definition("wf-keep");
    store.create(original.clone()).unwrap();

    // 结构非法：环。
    let mut cyclic = original.clone();
    cyclic.edges.push(edge("R", "A"));
    assert!(store.update(cyclic).is_err(), "环定义更新必须失败");

    // 角色缺失：新增节点引用不存在的角色。
    let mut ghost = original.clone();
    ghost.nodes.push(agent("G"));
    ghost.nodes.last_mut().unwrap().role_id = Some("role-ghost".into());
    ghost.edges.push(edge("R", "G"));
    assert!(store.update(ghost).is_err());

    assert_ser_eq_msg(
        &store.get("wf-keep").unwrap(),
        &original,
        "已保存定义必须不变",
    );
    assert_eq!(gw_refs(&store, "wf-keep"), vec!["role-a"], "登记保持原值");
}

/// SPEC「定义更新、删除与引用一致性」：更新事务内解除不再使用的旧引用、
/// 登记新增引用；登记或解除失败时事务整体回滚（定义与登记始终一致）。
#[test]
fn 更新事务登记同步与回滚() {
    let (store, gw, _path) = sqlite_store();
    let mut wf = def("wf-swap", vec![agent("A")], vec![]);
    store.create(wf.clone()).unwrap();
    assert_eq!(gw_refs(&store, "wf-swap"), vec!["role-a"]);

    // A→B 引用切换：旧登记解除、新登记建立。
    wf.nodes[0].role_id = Some("role-b".into());
    store.update(wf).unwrap();
    assert_eq!(gw_refs(&store, "wf-swap"), vec!["role-b"]);

    // 登记失败（注入故障）时定义更新整体回滚。
    let mut back = def("wf-swap", vec![agent("A")], vec![]);
    back.nodes[0].role_id = Some("role-a".into());
    gw.fail_register();
    assert!(store.update(back).is_err());
    gw.reset_failures();
    let current = store.get("wf-swap").unwrap();
    assert_eq!(current.nodes[0].role_id.as_deref(), Some("role-b"), "定义回滚");
    assert_eq!(gw_refs(&store, "wf-swap"), vec!["role-b"], "登记回滚");

    // 解除登记失败同样回滚。
    let mut third = def("wf-swap", vec![agent("A")], vec![]);
    third.nodes[0].role_id = Some("role-a".into());
    gw.fail_unregister();
    assert!(store.update(third).is_err());
    gw.reset_failures();
    assert_eq!(gw_refs(&store, "wf-swap"), vec!["role-b"]);
    assert_eq!(store.get("wf-swap").unwrap().nodes[0].role_id.as_deref(), Some("role-b"));
}

/// SPEC「定义更新、删除与引用一致性」：删除流程后其登记消失，其他流程
/// 的登记保留，重复删除按不存在语义返回 NotFound。
#[test]
fn 删除移除登记且保留其他流程() {
    let (store, _gw, _path) = sqlite_store();
    store
        .create(def("wf-del", vec![agent("A")], vec![]))
        .unwrap();
    store
        .create(def("wf-keep", vec![agent("A")], vec![]))
        .unwrap();

    store.delete("wf-del").unwrap();
    assert!(matches!(store.get("wf-del"), Err(WorkflowError::NotFound(_))));
    assert!(gw_refs(&store, "wf-del").is_empty(), "删除后登记消失");
    assert_eq!(gw_refs(&store, "wf-keep"), vec!["role-a"], "其他流程登记保留");

    // 重复删除：明确不存在语义。
    assert!(matches!(
        store.delete("wf-del"),
        Err(WorkflowError::NotFound(ref id)) if id == "wf-del"
    ));
}

/// SPEC「定义交付与编辑隔离」：读取定义后编辑原流程，旧的读取结果不变，
/// 新的读取结果反映修改；交付结果保留全部节点、边及配置。
#[test]
fn 交付隔离与往返完整() {
    let (store, _gw) = store();
    let wf = full_definition("wf-deliver");
    store.create(wf.clone()).unwrap();

    // 交付（克隆值）：读取后编辑原流程。
    let delivered = store.get("wf-deliver").unwrap();
    let mut edited = wf.clone();
    edited.name = "改名".into();
    edited.nodes[0].name = "节点改名".into();
    edited.nodes[0].position = Position { x: 99.0, y: 99.0 };
    store.update(edited).unwrap();

    assert_ser_eq_msg(&delivered, &wf, "旧读取结果必须保持稳定");
    let fresh = store.get("wf-deliver").unwrap();
    let fresh_json = serde_json::to_value(&fresh).unwrap();
    assert_ne!(
        fresh_json,
        serde_json::to_value(&wf).unwrap(),
        "新读取必须反映修改"
    );
    assert_eq!(fresh.name, "改名");
    assert_eq!(fresh.nodes[0].position.x, 99.0);
    assert_eq!(fresh.nodes[0].position.y, 99.0);

    // serde 往返：交付结果的全部节点、边、配置完整。
    let json = serde_json::to_string(&delivered).unwrap();
    let roundtrip: WorkflowDefinition = serde_json::from_str(&json).unwrap();
    assert_ser_eq(&roundtrip, &delivered);
    assert_eq!(roundtrip.nodes.len(), 3);
    assert_eq!(roundtrip.edges.len(), 2);
    assert_eq!(roundtrip.nodes[0].artifact_outputs.len(), 1);
    assert_eq!(
        roundtrip.nodes[0].artifact_outputs[0].media_type.as_deref(),
        Some("text/markdown")
    );
}

/// SPEC「角色引用校验」：保存路径的网关调用契约：同一角色去重后只查
/// 一次 exists，登记发生在全部存在性检查之后，重复引用去重登记。
#[test]
fn 保存调用契约_先检查后登记() {
    let (store, gw) = store();
    store
        .create(def(
            "wf-contract",
            vec![agent("A"), agent("B")],
            vec![edge("A", "B")],
        ))
        .unwrap();

    let calls = gw.call_log();
    assert_eq!(
        calls.iter().filter(|(_, op)| *op == "exists").count(),
        1,
        "同一角色去重后只查一次"
    );
    assert_eq!(calls.iter().filter(|(_, op)| *op == "register").count(), 1);
    let first_register = calls.iter().position(|(_, op)| *op == "register").unwrap();
    let last_exists = calls.iter().rposition(|(_, op)| *op == "exists").unwrap();
    assert!(
        last_exists < first_register,
        "登记必须发生在全部存在性检查之后"
    );
}

/// SPEC「定义交付与编辑隔离」：仅创建、修改、查询或删除流程时，不产生
/// 运行记录、执行会话或节点状态变更——本域接口面内无任何运行概念，
/// 以存储行为为证：更新失败定义不变，删除未知 id 报不存在。
#[test]
fn 流程操作不产生运行侧痕迹() {
    let (store, _gw) = store();
    store
        .create(def("wf-only", vec![agent("A")], vec![]))
        .unwrap();
    // 更新失败（agent 节点缺角色被结构校验拒绝）：定义不变。
    store
        .update(def(
            "wf-only",
            vec![super::testing::bare("B", NodeType::Agent)],
            vec![],
        ))
        .unwrap_err();
    let _ = store.get("wf-only").unwrap();
    let _ = store.list().unwrap();

    assert_eq!(store.get("wf-only").unwrap().nodes.len(), 1);
    assert!(matches!(
        store.delete("wf-other"),
        Err(WorkflowError::NotFound(_))
    ));
}

/// 经独立连接读取落库替身的登记表。
fn gw_refs(store: &WorkflowStore, workflow_id: &str) -> Vec<String> {
    let conn = store.conn();
    let conn = conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT role_id FROM workflow_role_refs WHERE workflow_id = ?1 ORDER BY role_id")
        .unwrap();
    stmt.query_map([workflow_id], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

/// domain 类型未实现 PartialEq，用 serde JSON 值比较替代（字段级一致）。
fn assert_ser_eq(a: &WorkflowDefinition, b: &WorkflowDefinition) {
    assert_ser_eq_msg(a, b, "");
}

/// 带消息版本。
fn assert_ser_eq_msg(a: &WorkflowDefinition, b: &WorkflowDefinition, msg: &str) {
    let ja = serde_json::to_value(a).unwrap();
    let jb = serde_json::to_value(b).unwrap();
    assert_eq!(ja, jb, "{}", msg);
}

/// 列表级比较。
fn assert_ser_eq_list(a: &[WorkflowDefinition], b: &[WorkflowDefinition]) {
    let ja = serde_json::to_value(a).unwrap();
    let jb = serde_json::to_value(b).unwrap();
    assert_eq!(ja, jb);
}
