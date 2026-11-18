//! HTTP API 验收测试：请求解析、参数传递、错误映射与凭据脱敏。
//!
//! 覆盖 SPEC transport「业务接口与错误映射」全部验收条目。
//! 服务监听 127.0.0.1:0 取动态端口（隔离纪律：bind 由测试决定）。

use std::net::SocketAddr;

use axum::http::StatusCode;
use reqwest::Client;
use serde_json::{json, Value};

use crate::transport::static_assets::StaticAssets;
use crate::transport::stubs::{
    sample_role, sample_workflow, test_app_state,
};
use crate::transport::{serve, ApiError};

/// 启动测试服务，返回 base URL 与替身句柄组。
async fn spawn_app() -> (
    String,
    std::sync::Arc<crate::transport::stubs::FakeWorkflows>,
    std::sync::Arc<crate::transport::stubs::FakeRoles>,
    std::sync::Arc<crate::transport::stubs::FakeRuns>,
    std::sync::Arc<crate::transport::stubs::FakeArtifacts>,
    std::sync::Arc<crate::transport::stubs::FakeSandboxes>,
    std::sync::Arc<crate::transport::stubs::FakeConnections>,
    std::sync::Arc<crate::transport::stubs::FakeEventFeed>,
) {
    let (state, workflows, roles, runs, artifacts, sandboxes, connections, events) =
        test_app_state(StaticAssets::disabled());
    let addr = serve(state, SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .expect("测试服务启动成功");
    (
        format!("http://{addr}"),
        workflows,
        roles,
        runs,
        artifacts,
        sandboxes,
        connections,
        events,
    )
}

/// SPEC「业务接口与错误映射」验收 1：
/// 给定有效请求，业务替身收到完整且正确的参数，响应保留服务返回的标识与结果。
#[tokio::test]
async fn valid_request_passes_full_params_and_preserves_result() {
    let (base, workflows, _roles, runs, artifacts, _sandboxes, _connections, _events) =
        spawn_app().await;
    let client = Client::new();

    // workflows：创建 -> 详情（响应保留服务返回的定义）。
    let wf = sample_workflow("wf-1");
    let body = serde_json::to_value(&wf).unwrap();
    let response = client
        .post(format!("{base}/api/v1/workflows"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let created: Value = response.json().await.unwrap();
    assert_eq!(created["id"], "wf-1");
    assert_eq!(created["name"], "demo");
    assert_eq!(created["nodes"][0]["id"], "n1");

    let fetched: Value = client
        .get(format!("{base}/api/v1/workflows/wf-1"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(fetched, created);

    // 替身收到完整参数。
    let calls = workflows.recorder.snapshot();
    assert_eq!(calls[0].method, "create_workflow");
    assert_eq!(calls[0].args, vec!["wf-1".to_string()]);

    // runs：创建运行并启动，参数与状态转换保留。
    let response = client
        .post(format!("{base}/api/v1/runs"))
        .json(&json!({ "workflowId": "wf-1", "input": "任务输入" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let run: Value = response.json().await.unwrap();
    let run_id = run["id"].as_str().unwrap().to_string();
    assert_eq!(run["status"], "queued");

    let calls = runs.recorder.snapshot();
    assert_eq!(
        calls[0].args,
        vec!["wf-1".to_string(), "任务输入".to_string()]
    );

    let started: Value = client
        .post(format!("{base}/api/v1/runs/{run_id}/start"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(started["status"], "running");

    // sandboxes：准备并查询（?runId 过滤）。
    let sbx: Value = client
        .post(format!("{base}/api/v1/sandboxes"))
        .json(&json!({ "runId": run_id, "spec": {} }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sbx_id = sbx["id"].as_str().unwrap().to_string();
    assert_eq!(sbx["runId"], run_id.as_str());
    let listed: Value = client
        .get(format!("{base}/api/v1/sandboxes?runId={run_id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["items"][0]["id"], sbx_id.as_str());
    assert_eq!(listed["items"][0]["lastObserved"], true);
    assert_eq!(sbx["lastObserved"], false);
    assert_eq!(listed["items"][0]["updatedAt"], sbx["updatedAt"]);

    // artifacts：预置后按 runId 过滤查询。
    artifacts.rows.lock().unwrap().push(
        crate::transport::ports::ArtifactDto {
            id: "art-1".into(),
            name: "报告".into(),
            path: "out/report.md".into(),
            media_type: Some("text/markdown".into()),
            run_id: run_id.clone(),
            node_id: "n1".into(),
            attempt: 1,
            content: Some("# 报告".into()),
        },
    );
    let got: Value = client
        .get(format!("{base}/api/v1/artifacts/art-1"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(got["id"], "art-1");
    assert_eq!(got["content"], "# 报告");
}

/// SPEC「业务接口与错误映射」验收 2：
/// 格式错误请求返回 4xx，业务服务不被调用。
#[tokio::test]
async fn malformed_request_is_400_and_service_not_called() {
    let (base, workflows, roles, runs, _artifacts, sandboxes, connections, _events) =
        spawn_app().await;
    let client = Client::new();

    // 非法 JSON。
    let response = client
        .post(format!("{base}/api/v1/workflows"))
        .header("content-type", "application/json")
        .body("{not json")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    // 类型不匹配的 JSON（workflowId 缺失 -> CreateRunRequest 解析失败）。
    let response = client
        .post(format!("{base}/api/v1/runs"))
        .json(&json!({ "input": 42 }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    // reject 缺 target_node_id -> 400。
    runs.seed(crate::transport::ports::RunDto {
        id: "run-r1".into(),
        status: "waiting".into(),
        workflow: sample_workflow("wf-x"),
        nodes: Vec::new(),
        generation: 1,
    });
    let response = client
        .post(format!("{base}/api/v1/runs/run-r1/reject"))
        .json(&json!({ "nodeId": "n2", "approved": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    // 业务替身均未被调用。
    assert!(workflows.recorder.snapshot().is_empty());
    assert!(roles.recorder.snapshot().is_empty());
    assert!(sandboxes.recorder.snapshot().is_empty());
    assert!(connections.recorder.snapshot().is_empty());
    // runs 只被 reject 前置 seed 影响（seed 不经 HTTP），HTTP 层 reject
    // 未触达业务接口：无 reject/approve/start 调用。
    let methods: Vec<_> = runs
        .recorder
        .method_names()
        .into_iter()
        .filter(|m| m != "seed")
        .collect();
    assert!(methods.is_empty(), "runs 业务接口不应被调用：{methods:?}");
}

/// SPEC「业务接口与错误映射」验收 3：
/// 资源不存在映射 404，引用或状态冲突映射 409，内部故障返回脱敏错误。
#[tokio::test]
async fn error_mapping_not_found_conflict_and_sanitized_internal() {
    let (base, workflows, _roles, runs, _artifacts, _sandboxes, connections, _events) =
        spawn_app().await;
    let client = Client::new();

    // 404：不存在的流程。
    let response = client
        .get(format!("{base}/api/v1/workflows/nope"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "not_found");
    assert_eq!(body["error"]["message"], "流程 nope 不存在");

    // 409：重复创建同名流程（冲突语义）。
    let wf = sample_workflow("wf-dup");
    let body = serde_json::to_value(&wf).unwrap();
    let response = client
        .post(format!("{base}/api/v1/workflows"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let response = client
        .post(format!("{base}/api/v1/workflows"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "conflict");

    // 409：非等待审批运行放行（状态冲突）。
    runs.seed(crate::transport::ports::RunDto {
        id: "run-c1".into(),
        status: "running".into(),
        workflow: sample_workflow("wf-x"),
        nodes: Vec::new(),
        generation: 1,
    });
    let response = client
        .post(format!("{base}/api/v1/runs/run-c1/approve"))
        .json(&json!({ "nodeId": "n1", "approved": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);

    // 409：删除被引用角色 / 连接。
    let response = client
        .delete(format!("{base}/api/v1/roles/role-referenced"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let response = client
        .delete(format!("{base}/api/v1/connections/conn-referenced"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);

    // 500 脱敏：注入内部错误（携带敏感标记），响应体不含内部详情。
    workflows.faults.set(
        "get_workflow",
        ApiError::Internal,
    );
    let response = client
        .get(format!("{base}/api/v1/workflows/wf-dup"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let text = response.text().await.unwrap();
    assert_eq!(text, r#"{"error":{"code":"internal_error","message":"服务内部错误"}}"#);
    assert!(!text.contains("sqlite"), "内部详情不得透出：{text}");

    // 连接内部故障同样脱敏。
    connections.faults.set("list_connections", ApiError::Internal);
    let response = client
        .get(format!("{base}/api/v1/connections"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

/// 控制面拒绝服务凭据、上游回包畸形与接入未配置，不能被压平为同一个 500。
#[tokio::test]
async fn sandbox_errors_have_distinct_safe_codes() {
    let (base, _, _, _, _, sandboxes, _, _) = spawn_app().await;
    let client = Client::new();
    for (error, status, code) in [
        (ApiError::GatewayUnauthorized, StatusCode::BAD_GATEWAY, "gateway_unauthorized"),
        (ApiError::GatewayProtocol, StatusCode::BAD_GATEWAY, "gateway_protocol_error"),
        (ApiError::conflict("沙箱操作冲突"), StatusCode::CONFLICT, "conflict"),
        (ApiError::SandboxUnavailable { message: "Gateway 未配置".into() }, StatusCode::SERVICE_UNAVAILABLE, "sandbox_unavailable"),
    ] {
        sandboxes.faults.set("prepare", error);
        let response = client.post(format!("{base}/api/v1/sandboxes"))
            .json(&json!({ "runId": "r", "spec": { "image": "test" } }))
            .send().await.unwrap();
        assert_eq!(response.status(), status);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"]["code"], code);
    }
}

/// SPEC「业务接口与错误映射」验收 4：
/// 角色配置与模型连接响应只返回允许展示的配置及凭据引用，
/// 认证信息不进入响应。
#[tokio::test]
async fn role_and_connection_responses_contain_no_credentials() {
    let (base, _workflows, _roles, _runs, _artifacts, _sandboxes, _connections, _events) =
        spawn_app().await;
    let client = Client::new();

    // 创建带 MCP 环境引用的角色。
    let role = sample_role("role-full");
    let response = client
        .post(format!("{base}/api/v1/roles"))
        .json(&serde_json::to_value(&role).unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let text = response.text().await.unwrap();
    let body: Value = serde_json::from_str(&text).unwrap();
    // 凭据引用保留（{{cred:...}}），无 apiKey/password/secret 明文字段。
    assert!(
        text.contains("{{cred:tok-main}}"),
        "凭据引用应原样保留：{text}"
    );
    for marker in ["apiKey", "password", "secret", "token_value", "sk-"] {
        assert!(!text.to_lowercase().contains(&marker.to_lowercase()), "响应含疑似凭据字段 {marker}：{text}");
    }
    // MCP 配置的 env 值是凭据引用。
    assert_eq!(
        body["mcpServers"][0]["env"][0][1],
        "{{cred:tok-main}}"
    );

    // 连接 CRUD：响应只有 credentialRef。
    let response = client
        .post(format!("{base}/api/v1/connections"))
        .json(&json!({
            "id": "conn-1",
            "name": "主连接",
            "serviceType": "anthropic",
            "endpoint": "https://api.anthropic.com",
            "credentialRef": "ref-vault-1"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let text = response.text().await.unwrap();
    assert!(text.contains("ref-vault-1"), "凭据引用应保留：{text}");
    for marker in ["apiKey", "password", "secretValue", "sk-ant-", "Bearer "] {
        assert!(!text.contains(marker), "响应含疑似凭据明文 {marker}：{text}");
    }
    let body: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(body["credentialRef"], "ref-vault-1");
    // 响应体顶层键集合：不允许出现任何密钥字段。
    let keys: Vec<String> = body
        .as_object()
        .unwrap()
        .keys()
        .map(|k| k.to_string())
        .collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(
        sorted,
        vec![
            "credentialRef".to_string(),
            "endpoint".to_string(),
            "id".to_string(),
            "name".to_string(),
            "serviceType".to_string()
        ]
    );
}

/// 更新与删除资源的行为链（CRUD 完整用例）。
#[tokio::test]
async fn workflow_update_and_delete_flow() {
    let (base, workflows, _roles, _runs, _artifacts, _sandboxes, _connections, _events) =
        spawn_app().await;
    let client = Client::new();

    let wf = sample_workflow("wf-u1");
    let response = client
        .post(format!("{base}/api/v1/workflows"))
        .json(&serde_json::to_value(&wf).unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    let mut updated = wf.clone();
    updated.name = "改名".into();
    let response = client
        .put(format!("{base}/api/v1/workflows/wf-u1"))
        .json(&serde_json::to_value(&updated).unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["name"], "改名");

    let response = client
        .delete(format!("{base}/api/v1/workflows/wf-u1"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let response = client
        .get(format!("{base}/api/v1/workflows/wf-u1"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let methods = workflows.recorder.method_names();
    assert_eq!(
        methods,
        vec![
            "create_workflow",
            "update_workflow",
            "delete_workflow",
            "get_workflow"
        ]
    );
}
