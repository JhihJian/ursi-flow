//! 使用生产 Runner 调用真实 Runtime。Gateway 只提供测试 run 的资源视图。
//! scripts/verify_runtime_acp.sh 提供 Runtime、固定模型、凭据及回收核验。
#![cfg(feature = "sandbox-access")]

use std::{net::SocketAddr, time::Duration};

use axum::{
    Json, Router,
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::process::Command;

const SANDBOX: &str = "sb-real-acp";

async fn post_json(base: &str, path: &str, body: Value, expected: StatusCode) -> Value {
    let response = reqwest::Client::new()
        .post(format!("{base}/{path}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.json().await.unwrap();
    assert_eq!(status, expected, "POST {path}: {body}");
    body
}

#[tokio::test]
#[ignore = "需要显式 URSI_FLOW_REAL_ACP=1 和运行中的 Runtime ACP 服务"]
async fn flow_runner_can_verify_real_runtime_acp() {
    assert_eq!(std::env::var("URSI_FLOW_REAL_ACP").as_deref(), Ok("1"));
    // The URL must round-trip to precisely the IP:port that the binding pins.
    let url = std::env::var("URSI_ACP_URL").unwrap();
    let address: SocketAddr = url
        .strip_prefix("ws://")
        .and_then(|s| s.strip_suffix("/acp"))
        .and_then(|s| s.parse().ok())
        .expect("需要 ws://<内部 IP:port>/acp");
    let token = match (
        std::env::var_os("URSI_SESSION_TOKEN"),
        std::env::var_os("URSI_SESSION_TOKEN_FILE"),
    ) {
        (None, Some(path)) => std::fs::read_to_string(path).unwrap(),
        (Some(value), None) => value.into_string().ok().expect("token 须为 UTF-8"),
        _ => panic!("需要且仅允许一种 Runtime token 来源"),
    };
    let gateway = Router::new()
        .route("/api/v1/sandboxes", post(|| async { (StatusCode::ACCEPTED, Json(json!({"id":SANDBOX,"status":"preparing","operation":{"kind":"create"},"endpoints":[]}))) }))
        .route(&format!("/api/v1/sandboxes/{SANDBOX}"), get(move || async move { Json(json!({"id":SANDBOX,"status":"running","operation":null,"endpoints":[{"name":"session","port":address.port(),"address":address,"visibility":"internal"}]})) }).delete(|| async { (StatusCode::NOT_FOUND, Json(json!({"error":{"code":"not_found","message":"gone"}}))) }));
    let gw = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let data = tempfile::tempdir().unwrap();
    let mut bindings = tempfile::Builder::new();
    #[cfg(unix)]
    bindings.permissions(std::os::unix::fs::PermissionsExt::from_mode(0o700));
    let bindings = bindings.tempdir().unwrap();
    let gateway_url = format!("http://127.0.0.1:{}", gw.local_addr().unwrap().port());
    let gw = tokio::spawn(async move { axum::serve(gw, gateway).await.unwrap() });
    let port = TcpListener::bind("0.0.0.0:0")
        .await
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    // Only the fixture reads the CLI's global URL/token. The production Server
    // must not inherit them, and authenticates solely through the run binding.
    let mut server = Command::new(env!("CARGO_BIN_EXE_ursi-flow"))
        .env_clear()
        .env("URSI_LISTEN_ADDR", format!("0.0.0.0:{port}"))
        .env("URSI_DATA_DIR", data.path())
        .env("URSI_GATEWAY_URL", gateway_url)
        .env("URSI_GATEWAY_KEY", "fixture-gateway-only")
        .env("URSI_ACP_BINDINGS_DIR", bindings.path())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            assert!(server.try_wait().unwrap().is_none(), "Server 启动失败");
            if tokio::net::TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], port)))
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("等待 Server 监听超时");
    let base = format!("http://127.0.0.1:{port}/api/v1");
    let conn = post_json(&base,"connections",json!({"id":"c","name":"fixture","serviceType":"openai_compatible","endpoint":"http://127.0.0.1:18080/v1","credentialRef":"vault://fixture"}),StatusCode::CREATED).await;
    post_json(
        &base,
        "roles",
        json!({"id":"r","name":"ACP","prompt":"只回复 ACP-OK。","model":"fixed",
            "executorKind":"pi","connectionId":conn["id"],
            "skills":[{"path":"SKILL.md","content":"直接回复纯文本。"}],"mcpServers":[]}),
        StatusCode::CREATED,
    )
    .await;
    post_json(&base,"workflows",json!({"id":"w","name":"ACP","nodes":[{"id":"n","type":"agent","name":"确认 ACP 已接通","roleId":"r"}]}),StatusCode::CREATED).await;
    let run = post_json(
        &base,
        "runs",
        json!({"workflowId":"w"}),
        StatusCode::CREATED,
    )
    .await;
    let run = run["id"].as_str().unwrap();
    post_json(&base,"sandboxes",json!({"runId":run,"spec":{"image":"fixture","runtime_profile":"pi","ports":[{"name":"session","port":address.port(),"visibility":"internal","ready":true}]}}),StatusCode::ACCEPTED).await;
    let mut identity = tempfile::NamedTempFile::new_in(bindings.path()).unwrap();
    serde_json::to_writer(&mut identity, &json!({"sandbox_id":SANDBOX,"address":address,"model":"fixed","token":token.trim_end_matches(['\r','\n'])})).unwrap();
    identity
        .persist(bindings.path().join(format!("{run}.json")))
        .unwrap();
    let result = post_json(
        &base,
        &format!("runs/{run}/start"),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(result["status"], "succeeded");
    assert_eq!(result["nodes"][0]["attempt"], 1);
    assert_eq!(result["nodes"][0]["output"], "ACP-OK");
    server.kill().await.unwrap();
    gw.abort();
}
