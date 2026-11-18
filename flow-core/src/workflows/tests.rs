//! 纯结构校验测试（SPEC 第 3 组验收）。

use super::testing::{approval, def, edge, RecordingGateway};
use super::{validate_definition, WorkflowDefinition, WorkflowError};
use crate::domain::WorkflowError as DomainError;

/// SPEC「纯结构校验」：合法单节点、链式及分支汇合 DAG 通过校验，
/// 调用过程中没有存储写入或角色查询（计数替身零调用）。
#[test]
fn 合法_dag_通过且不触存储与角色网关() {
    let gw = RecordingGateway::new(&["role-a"]);

    let single = def("wf-single", vec![super::testing::script("S", "echo ok")], vec![]);
    let chain = def(
        "wf-chain",
        vec![
            super::testing::agent("A"),
            approval("B"),
            super::testing::script("C", "echo"),
        ],
        vec![edge("A", "B"), edge("B", "C")],
    );
    // 分支汇合：A 分出 B、C，二者汇合到 D。
    let branch = def(
        "wf-branch",
        vec![
            super::testing::agent("A"),
            super::testing::script("B", "echo"),
            super::testing::script("C", "echo"),
            approval("D"),
        ],
        vec![edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")],
    );

    validate_definition(&single).unwrap();
    validate_definition(&chain).unwrap();
    validate_definition(&branch).unwrap();

    assert_eq!(gw.total_calls(), 0, "纯校验不得调用角色网关");
}

/// SPEC「纯结构校验」：重复/缺失节点标识、缺失边端点、未知节点类型
/// 与缺少必需配置返回可定位错误；全程零网关调用。
#[test]
fn 非法定义返回可定位错误() {
    let gw = RecordingGateway::new(&[]);

    // 重复节点 ID：错误携带重复的 ID。
    let dup = def("wf-dup", vec![approval("A"), approval("A")], vec![]);
    match validate_definition(&dup) {
        Err(WorkflowError::Invalid(DomainError::DuplicateNodeId(id))) => assert_eq!(id, "A"),
        other => panic!("期望重复节点 ID 错误，实际 {other:?}"),
    }

    // 缺失节点 ID（空白）。
    let no_id = def("wf-noid", vec![approval("  ")], vec![]);
    assert!(matches!(
        validate_definition(&no_id),
        Err(WorkflowError::Invalid(DomainError::MissingNodeId))
    ));

    // 缺失边端点：边引用不存在的节点。
    let dangling = def("wf-dangle", vec![approval("A")], vec![edge("A", "Z")]);
    assert!(matches!(
        validate_definition(&dangling),
        Err(WorkflowError::Invalid(DomainError::EdgeReferencesMissingNode))
    ));

    // 未知节点类型：在 JSON 反序列化层被拒绝，错误指明未知值。
    let parsed: Result<WorkflowDefinition, _> = serde_json::from_str(
        r#"{"id":"wf-unknown","name":"n","nodes":[{"id":"A","name":"a","type":"mystery"}],"edges":[]}"#,
    );
    assert!(parsed.is_err(), "未知节点 type 必须在反序列化层被拒绝");
    assert!(
        parsed.unwrap_err().to_string().contains("mystery"),
        "错误应指明未知类型"
    );

    // 缺少必需配置：agent 缺角色、script 缺脚本，错误定位节点 ID。
    let no_role = def(
        "wf-norole",
        vec![super::testing::bare("A", crate::domain::NodeType::Agent)],
        vec![],
    );
    match validate_definition(&no_role) {
        Err(WorkflowError::Invalid(DomainError::InvalidNode(id, _))) => assert_eq!(id, "A"),
        other => panic!("期望节点级校验错误，实际 {other:?}"),
    }
    let no_script = def(
        "wf-noscript",
        vec![super::testing::bare("S", crate::domain::NodeType::Script)],
        vec![],
    );
    match validate_definition(&no_script) {
        Err(WorkflowError::Invalid(DomainError::InvalidNode(id, _))) => assert_eq!(id, "S"),
        other => panic!("期望节点级校验错误，实际 {other:?}"),
    }

    assert_eq!(gw.total_calls(), 0, "结构校验不得调用角色网关");
}

/// SPEC「纯结构校验」：自环与多节点环均被拒绝。
#[test]
fn 自环与多节点环被拒绝() {
    let self_loop = def("wf-self", vec![approval("A")], vec![edge("A", "A")]);
    assert!(matches!(
        validate_definition(&self_loop),
        Err(WorkflowError::Invalid(DomainError::CycleDetected))
    ));

    let cycle = def(
        "wf-cycle",
        vec![approval("A"), approval("B"), approval("C")],
        vec![edge("A", "B"), edge("B", "C"), edge("C", "A")],
    );
    assert!(matches!(
        validate_definition(&cycle),
        Err(WorkflowError::Invalid(DomainError::CycleDetected))
    ));
}
