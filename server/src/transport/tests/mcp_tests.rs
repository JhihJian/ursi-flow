//! MCP 接入验收测试：POST /api/v1/mcp/invoke、可信上下文映射、身份
//! 参数拒绝、越权拒绝与错误语义一致性。
//!
//! 覆盖 SPEC transport「MCP 与连接协议接入」前三条验收。

use std::net::SocketAddr;

use axum::http::StatusCode;
use reqwest::Client;
use serde_json::{json, Value};

use crate::transport::static_assets::StaticAssets;
use crate::transport::stubs::test_app_state;
use crate::transport::serve;

async fn spawn_app() -> String {
    let (state, _wf, _roles, _runs, _art, _sbx, _conn, _events) =
        test_app_state(StaticAssets::disabled());
    let addr = serve(state, SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .expect("测试服务启动成功");
    format!("http://{addr}")
}

/// SPEC「MCP 与连接协议接入」验收 1 + 工具清单：
/// 运维域/控制域工具可调用；等价业务校验语义一致（错误码一致）。
#[tokio::test]
async fn ops_tool_invocation_and_error_semantics_match_http() {
    let base = spawn_app().await;
    let client = Client::new();

    // ops 域工具不需要运行上下文。
    let response = client
        .post(format!("{base}/api/v1/mcp/invoke"))
        .json(&json!({ "name": "ops_gateway_status", "args": {} }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["result"]["reachable"], true);

    // 未知工具 -> 404（与 HTTP 资源不存在同一 not_found 语义）。
    let response = client
        .post(format!("{base}/api/v1/mcp/invoke"))
        .json(&json!({ "name": "no_such_tool", "args": {} }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "not_found");

    // 工具参数无效 -> 400。
    let response = client
        .post(format!("{base}/api/v1/mcp/invoke"))
        .json(&json!({ "name": "ops_get_sandbox", "args": {} }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "invalid_request");
}

/// SPEC「MCP 与连接协议接入」验收 1（上下文部分）：
/// 内部域调用缺少可信上下文 -> 400 missing_context（与 HTTP 上下文缺失
/// 语义一致）。
#[tokio::test]
async fn internal_tool_without_context_is_rejected() {
    let base = spawn_app().await;
    let client = Client::new();

    // 无 x-run-id 头调用内部域工具。
    let response = client
        .post(format!("{base}/api/v1/mcp/invoke"))
        .json(&json!({ "name": "internal_get_run_status", "args": {} }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "missing_context");
}

/// SPEC「MCP 与连接协议接入」验收 2：
/// agent 无法用工具参数覆盖可信上下文中的运行和节点归属。
#[tokio::test]
async fn tool_args_cannot_override_trusted_context() {
    let base = spawn_app().await;
    let client = Client::new();

    // args 顶层携带 run_id：mcp-server 校验透传拒绝 -> 400。
    let response = client
        .post(format!("{base}/api/v1/mcp/invoke"))
        .header("x-run-id", "run-1")
        .header("x-node-id", "node-a")
        .json(&json!({
            "name": "internal_list_artifacts",
            "args": { "run_id": "run-victim" }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = response.json().await.unwrap();
    let message = body["error"]["message"].as_str().unwrap();
    assert!(message.contains("run_id"), "错误应指出身份字段：{message}");

    // camelCase 同样拒绝（mcp-server FORBIDDEN_IDENTITY_KEYS）。
    let response = client
        .post(format!("{base}/api/v1/mcp/invoke"))
        .header("x-run-id", "run-1")
        .json(&json!({
            "name": "internal_list_artifacts",
            "args": { "runId": "run-victim" }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

/// SPEC「MCP 与连接协议接入」验收 3：
/// 未授权的运行资源访问被拒绝（越权 403，与 HTTP 业务校验语义一致）。
#[tokio::test]
async fn cross_run_access_is_forbidden() {
    let base = spawn_app().await;
    let client = Client::new();

    // 上下文 run-2 访问 run-1 的产物 -> 403 forbidden。
    let response = client
        .post(format!("{base}/api/v1/mcp/invoke"))
        .header("x-run-id", "run-2")
        .header("x-node-id", "node-a")
        .json(&json!({
            "name": "internal_get_artifact",
            "args": { "artifact_id": "art-1" }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "forbidden");
    let message = body["error"]["message"].as_str().unwrap();
    assert!(message.contains("run-1") && message.contains("run-2"));

    // 授权上下文访问自己的产物 -> 200。
    let response = client
        .post(format!("{base}/api/v1/mcp/invoke"))
        .header("x-run-id", "run-1")
        .header("x-node-id", "node-a")
        .json(&json!({
            "name": "internal_get_artifact",
            "args": { "artifact_id": "art-1" }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["result"]["artifactId"], "art-1");
    assert_eq!(body["result"]["ownerRunId"], "run-1");

    // 合法调用不携带身份参数，身份全部来自头。
    let response = client
        .post(format!("{base}/api/v1/mcp/invoke"))
        .header("x-run-id", "run-1")
        .json(&json!({ "name": "internal_list_artifacts", "args": {} }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["result"][0]["ownerRunId"], "run-1");
}

/// 内部故障脱敏：backend 执行失败（含业务 NotFound 被 mcp-server 归入
/// Execution 形态）统一脱敏，不透出内部错误详情。
#[tokio::test]
async fn backend_failure_is_sanitized() {
    let base = spawn_app().await;
    let client = Client::new();

    // mcp-server 现状：内部域 backend 的 NotFound 以 ToolError::Execution
    // 形态上抛（见 domains.rs internal_execution），transport 层按验收
    // 统一脱敏为 500，不透出内部消息。
    let response = client
        .post(format!("{base}/api/v1/mcp/invoke"))
        .header("x-run-id", "run-1")
        .json(&json!({
            "name": "internal_get_artifact",
            "args": { "artifact_id": "missing-art" }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let text = response.text().await.unwrap();
    let body: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(body["error"]["code"], "internal_error");
    assert_eq!(body["error"]["message"], "服务内部错误");
    assert!(!text.contains("missing-art"), "内部详情不得透出：{text}");
}
