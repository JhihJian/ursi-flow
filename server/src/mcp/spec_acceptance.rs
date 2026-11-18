//! SPEC 验收测试：工具域注册与运行上下文注入。

use std::sync::Arc;
use crate::mcp::stubs::{
    recording_control_backend, recording_internal_backend, recording_ops_backend,
    RecordingControlBackend, RecordingInternalBackend, RecordingOpsBackend,
};
use crate::mcp::{
    ArtifactView, Domain, DomainId, InvocationContext, McpServer, ToolError,
};

/// 装配全部三域的 server，返回 server 与三个替身 backend。
fn full_server() -> (
    McpServer,
    Arc<RecordingOpsBackend>,
    Arc<RecordingControlBackend>,
    Arc<RecordingInternalBackend>,
) {
    let ops = Arc::new(recording_ops_backend());
    let control = Arc::new(recording_control_backend());
    let internal = Arc::new(recording_internal_backend(artifacts_fixture()));
    let server = McpServer::register_domain(&[
        Domain::Ops(ops.clone()),
        Domain::Control(control.clone()),
        Domain::Internal(internal.clone()),
    ])
    .expect("三域无同名工具，装配成功");
    (server, ops, control, internal)
}

fn artifacts_fixture() -> Vec<ArtifactView> {
    vec![
        ArtifactView {
            artifact_id: "art-1".into(),
            name: "设计文档".into(),
            path: "out/design.md".into(),
            owner_run_id: "run-1".into(),
            owner_node_id: "node-a".into(),
        },
        ArtifactView {
            artifact_id: "art-2".into(),
            name: "其他运行产物".into(),
            path: "out/other.md".into(),
            owner_run_id: "run-2".into(),
            owner_node_id: "node-x".into(),
        },
    ]
}

fn ctx_run1() -> InvocationContext {
    InvocationContext::new("run-1", "node-a", "sess-1")
}

// ---------- 验收一：工具域注册 ----------

#[test]
fn registered_domain_tools_are_discoverable_and_invokable() {
    let (server, _ops, _control, _internal) = full_server();

    // list_tools 汇总三域工具，均带 name/description/schema。
    let tools = server.list_tools(None);
    let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "ops_list_sandboxes",
            "ops_get_sandbox",
            "ops_restart_sandbox",
            "ops_stop_sandbox",
            "ops_gateway_status",
            "control_get_run",
            "control_list_runs",
            "control_cancel_run",
            "control_approve",
            "internal_get_run_status",
            "internal_list_nodes",
            "internal_get_artifact",
            "internal_list_artifacts",
        ]
    );
    for t in &tools {
        assert!(!t.description.is_empty(), "{} 缺少描述", t.name);
        assert!(t.input_schema.is_object(), "{} 缺少 schema", t.name);
    }

    // 调用运维域工具，命中替身 backend。
    let out = block_on(server.invoke(
        "ops_restart_sandbox",
        None,
        serde_json::json!({"sandbox_id": "sbx-9"}),
    ))
    .unwrap();
    assert_eq!(out, serde_json::json!({"changed": true}));
}

#[test]
fn unregistered_domain_is_invisible() {
    let control = Arc::new(recording_control_backend());
    let server = McpServer::with_domain(Domain::Control(control.clone())).unwrap();

    let names: Vec<String> = server
        .list_tools(None)
        .iter()
        .map(|t| t.name.clone())
        .collect();
    assert!(!names.iter().any(|n| n.starts_with("ops_")));
    assert!(!names.iter().any(|n| n.starts_with("internal_")));

    let err = block_on(server.invoke(
        "ops_restart_sandbox",
        None,
        serde_json::json!({}),
    ))
    .unwrap_err();
    assert_eq!(
        err,
        ToolError::UnknownTool {
            name: "ops_restart_sandbox".into()
        }
    );

    let err = block_on(server.invoke(
        "internal_list_nodes",
        None,
        serde_json::json!({}),
    ))
    .unwrap_err();
    assert_eq!(
        err,
        ToolError::UnknownTool {
            name: "internal_list_nodes".into()
        }
    );

    let out = block_on(server.invoke(
        "control_get_run",
        None,
        serde_json::json!({"run_id": "run-1"}),
    ))
    .unwrap();
    assert_eq!(out["runId"], "run-1");
    assert_eq!(
        control.recorder.method_names(),
        vec!["get_run".to_string()]
    );
}

#[test]
fn list_tools_per_domain_filter() {
    let (server, _ops, _control, _internal) = full_server();
    let ops_names: Vec<String> = server
        .list_tools(Some(DomainId::Ops))
        .iter()
        .map(|t| t.name.clone())
        .collect();
    assert_eq!(
        ops_names,
        vec![
            "ops_list_sandboxes",
            "ops_get_sandbox",
            "ops_restart_sandbox",
            "ops_stop_sandbox",
            "ops_gateway_status",
        ]
    );

    let only_ops = McpServer::with_domain(recording_ops_domain()).unwrap();
    assert!(only_ops.list_tools(Some(DomainId::Internal)).is_empty());
}

#[test]
fn ops_and_control_calls_reach_stub_backends() {
    let (server, ops, control, internal) = full_server();

    let out = block_on(server.invoke(
        "control_approve",
        None,
        serde_json::json!({
            "run_id": "run-1",
            "node_id": "node-a",
            "approved": true
        }),
    ))
    .unwrap();
    assert_eq!(out, serde_json::json!({"changed": true}));
    assert_eq!(
        control.recorder.snapshot(),
        vec![call_of("approve", &["run-1", "node-a", "true"])]
    );

    block_on(server.invoke(
        "ops_list_sandboxes",
        None,
        serde_json::json!({"run_id": "run-1"}),
    ))
    .unwrap();
    assert_eq!(
        ops.recorder.method_names(),
        vec!["list_sandboxes".to_string()]
    );

    block_on(server.invoke(
        "internal_list_nodes",
        Some(&ctx_run1()),
        serde_json::json!({}),
    ))
    .unwrap();
    assert_eq!(
        internal.recorder.method_names(),
        vec!["list_nodes".to_string()]
    );
}

// ---------- 验收二：运行上下文注入 ----------

#[test]
fn internal_tools_require_context() {
    let (server, _ops, _control, internal) = full_server();

    for tool in [
        "internal_get_run_status",
        "internal_list_nodes",
        "internal_list_artifacts",
    ] {
        let err = block_on(server.invoke(tool, None, serde_json::json!({}))).unwrap_err();
        assert_eq!(err, ToolError::MissingInvocationContext, "tool={tool}");
    }
    let err = block_on(server.invoke(
        "internal_get_artifact",
        None,
        serde_json::json!({"artifact_id": "art-1"}),
    ))
    .unwrap_err();
    assert_eq!(err, ToolError::MissingInvocationContext);
    assert!(internal.recorder.snapshot().is_empty());
}

#[test]
fn internal_tools_reject_identity_args() {
    let (server, _ops, _control, internal) = full_server();

    let err = block_on(server.invoke(
        "internal_get_run_status",
        Some(&ctx_run1()),
        serde_json::json!({"run_id": "run-2"}),
    ))
    .unwrap_err();
    assert_eq!(
        err,
        ToolError::ForbiddenIdentityArgs {
            keys: vec!["run_id".into()]
        }
    );
    assert!(internal.recorder.snapshot().is_empty());

    let err = block_on(server.invoke(
        "internal_list_nodes",
        Some(&ctx_run1()),
        serde_json::json!({"nodeId": "node-x"}),
    ))
    .unwrap_err();
    assert!(matches!(err, ToolError::ForbiddenIdentityArgs { .. }));
}

#[test]
fn internal_tools_reject_cross_run_reference() {
    let (server, _ops, _control, internal) = full_server();

    let err = block_on(server.invoke(
        "internal_get_artifact",
        Some(&ctx_run1()),
        serde_json::json!({"artifact_id": "art-2"}),
    ))
    .unwrap_err();
    assert_eq!(
        err,
        ToolError::CrossRunAccess {
            resource: "art-2".into(),
            owner_run: "run-2".into(),
            context_run: "run-1".into(),
        }
    );
    assert_eq!(
        internal.recorder.method_names(),
        vec!["get_artifact".to_string()]
    );
}

#[test]
fn internal_tools_succeed_with_context_and_pass_identity() {
    let (server, _ops, _control, internal) = full_server();

    let out = block_on(server.invoke(
        "internal_get_run_status",
        Some(&ctx_run1()),
        serde_json::json!({}),
    ))
    .unwrap();
    assert_eq!(out["runId"], "run-1");

    let out = block_on(server.invoke(
        "internal_get_artifact",
        Some(&ctx_run1()),
        serde_json::json!({"artifact_id": "art-1"}),
    ))
    .unwrap();
    assert_eq!(out["artifactId"], "art-1");
    assert_eq!(out["ownerRunId"], "run-1");

    let calls = internal.recorder.snapshot();
    assert!(calls.contains(&call_of("get_run_status", &["run-1"])));
    assert!(calls.contains(&call_of("get_artifact", &["run-1", "art-1"])));
}

#[test]
fn duplicate_domain_assembly_fails() {
    let err = McpServer::register_domain(&[
        Domain::Control(Arc::new(recording_control_backend())),
        Domain::Control(Arc::new(recording_control_backend())),
    ])
    .unwrap_err();
    assert_eq!(
        err,
        crate::mcp::AssemblyError::DuplicateDomain {
            domain: crate::mcp::DomainId::Control
        }
    );
}

// ---------- 辅助 ----------

fn recording_ops_domain() -> Domain {
    Domain::Ops(Arc::new(recording_ops_backend()))
}

fn call_of(method: &str, args: &[&str]) -> crate::mcp::stubs::Call {
    crate::mcp::stubs::Call {
        method: method.into(),
        args: args.iter().map(|s| (*s).to_string()).collect(),
    }
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}
