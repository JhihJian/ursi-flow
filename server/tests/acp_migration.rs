//! 升级后必须显式迁移全局执行身份和旧角色，不能替换已冻结的任务。
use std::{process::Stdio, sync::Arc, time::Duration};

use flow_core::runs::{RunRepository, SqliteRunStore, SystemClock};

use reqwest::{Client, RequestBuilder, StatusCode};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio::process::Command;
use ursi_server::app::{AppConfig, assemble};

#[tokio::test]
async fn legacy_env_fails_startup_before_storage_without_disclosing_values() {
    let root = tempdir().unwrap();
    let data = root.path().join("unopened");
    const SECRET: &str = "legacy-private-value";
    for key in [
        "URSI_ACP_URL",
        "URSI_SESSION_TOKEN",
        "URSI_SESSION_TOKEN_FILE",
        "URSI_CLIENT_TIMEOUT_SECS",
    ] {
        let output = tokio::time::timeout(
            Duration::from_secs(5),
            Command::new(env!("CARGO_BIN_EXE_ursi-flow"))
                .env_clear()
                .env("URSI_DATA_DIR", &data)
                .env("URSI_LISTEN_ADDR", "0.0.0.0:0")
                .env("URSI_GATEWAY_URL", "http://127.0.0.1:1")
                .env("URSI_GATEWAY_KEY", "control-only")
                .env("URSI_ACP_BINDINGS_DIR", root.path())
                .env(key, SECRET)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .expect("旧配置不应进入监听")
        .unwrap();
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(
            stderr.contains(key)
                && stderr.contains("迁移")
                && stderr.contains("URSI_ACP_BINDINGS_DIR"),
            "{stderr}"
        );
        assert!(!stderr.contains(SECRET));
        assert!(!String::from_utf8_lossy(&output.stdout).contains(SECRET));
        assert!(!data.exists());
    }
}

async fn response(req: RequestBuilder, expected: StatusCode) -> Value {
    let response = req.send().await.unwrap();
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert_eq!(status, expected, "{body}");
    body
}

// 上个 Server 已发送 prompt 后失去回执，升级后也不能宣称任务已取消。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupted_legacy_attempt_is_neither_replayed_nor_confirmed_cancelled() {
    let dir = tempdir().unwrap();
    let config = AppConfig::for_test(dir.path().into());
    let store = SqliteRunStore::open(config.runs_db_path(), Arc::new(SystemClock)).unwrap();
    let run = serde_json::from_value(json!({
        "id":"old-run", "status":"running", "generation":1,
        "workflow":{"id":"w", "name":"w", "nodes":[{"id":"n","name":"n","type":"agent","roleId":"r","maxAttempts":3}]},
        "nodes":[{"nodeId":"n", "status":"running", "attempts":1}]
    })).unwrap();
    let frozen = serde_json::from_value(json!({"r":{"id":"r","name":"r","prompt":"p","model":"runtime-profile","executorKind":"runtime-acp"}})).unwrap();
    store.create_run(&run, &frozen).await.unwrap();
    let app = assemble(config).await.unwrap();
    let url = format!("http://{}/api/v1/runs/old-run", app.addr());
    let client = Client::new();
    expect_migration(client.post(format!("{url}/start"))).await;
    response(client.post(format!("{url}/cancel")), StatusCode::CONFLICT).await;
    let run = response(client.get(url), StatusCode::OK).await;
    assert_eq!(run["status"], "running");
    assert_eq!(run["nodes"][0]["status"], "running");
    assert_eq!(run["nodes"][0]["attempt"], 1);
    assert!(store.cleanup_status("old-run").await.unwrap().is_none());
    app.shutdown().await;
}

async fn expect_migration(req: RequestBuilder) {
    let body = response(req, StatusCode::CONFLICT).await;
    let message = body["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("runtime-acp") && message.contains("迁移"),
        "{message}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_roles_and_snapshots_survive_restart_but_cannot_dispatch() {
    let dir = tempdir().unwrap();
    let config = AppConfig::for_test(dir.path().into());
    let app = assemble(config.clone()).await.unwrap();
    let api = format!("http://{}/api/v1", app.addr());
    let client = Client::new();
    let connection = response(client.post(format!("{api}/connections")).json(&json!({
        "id":"c", "name":"c", "serviceType":"openai_compatible", "endpoint":"https://example.test", "credentialRef":"vault://test"
    })), StatusCode::CREATED).await;
    let pi = json!({"id":"r","name":"r","prompt":"p","connectionId":connection["id"],"model":"pi-model","executorKind":"pi","skills":[{"path":"SKILL.md","content":"instructions"}]});
    let mut legacy = pi.clone();
    legacy["model"] = json!("runtime-profile");
    legacy["executorKind"] = json!("runtime-acp");
    legacy["skills"] = json!([]);
    expect_migration(client.post(format!("{api}/roles")).json(&legacy)).await;
    response(
        client.post(format!("{api}/roles")).json(&pi),
        StatusCode::CREATED,
    )
    .await;
    response(client.post(format!("{api}/workflows")).json(&json!({"id":"w","name":"w","nodes":[{"id":"n","name":"n","type":"agent","roleId":"r","maxAttempts":3}]})), StatusCode::CREATED).await;
    let create = json!({"workflowId":"w"});
    let run = response(
        client.post(format!("{api}/runs")).json(&create),
        StatusCode::CREATED,
    )
    .await;
    let id = run["id"].as_str().unwrap();
    app.shutdown().await;
    drop(app);

    // 在服务停止时安装 main 的持久化格式：空技能包、固定 profile、扁平的角色快照。
    let base = json!({"id":"r","name":"r","prompt":"legacy","model":"runtime-profile","skills":[],"mcpServers":[]});
    let mut frozen = base.clone();
    frozen["executorKind"] = json!("runtime-acp");
    {
        let roles = Connection::open(config.shared_db_path()).unwrap();
        roles
            .execute(
                "UPDATE roles SET executor_kind='runtime-acp', base_json=?1 WHERE id='r'",
                [base.to_string()],
            )
            .unwrap();
        roles
            .execute("DELETE FROM role_files WHERE role_id='r'", [])
            .unwrap();
        let runs = Connection::open(config.runs_db_path()).unwrap();
        runs.execute("UPDATE runs SET snapshot_json=json_set(snapshot_json, '$.roles.r', json(?1)) WHERE id=?2", params![frozen.to_string(), id]).unwrap();
    }
    let app = assemble(config.clone()).await.unwrap();
    let api = format!("http://{}/api/v1", app.addr());
    let role_url = format!("{api}/roles/r");
    let old_role = response(client.get(&role_url), StatusCode::OK).await;
    assert_eq!(old_role["executorKind"], "runtime-acp");
    expect_migration(client.post(format!("{api}/runs")).json(&create)).await;
    response(client.put(&role_url).json(&pi), StatusCode::OK).await;

    // 即使当前角色已迁移，start 也只能按快照作决定。拒绝不占 attempt。
    let old_url = format!("{api}/runs/{id}");
    expect_migration(client.post(format!("{old_url}/start"))).await;
    let old = response(client.get(&old_url), StatusCode::OK).await;
    assert_eq!(old["status"], "queued");
    assert_eq!(old["nodes"][0]["attempt"], 0);
    let new = response(
        client.post(format!("{api}/runs")).json(&create),
        StatusCode::CREATED,
    )
    .await;
    let start = format!("{api}/runs/{}/start", new["id"].as_str().unwrap());
    let err = response(client.post(start), StatusCode::SERVICE_UNAVAILABLE).await;
    assert_eq!(err["error"]["code"], "sandbox_unavailable");
    let cancelled = response(client.post(format!("{old_url}/cancel")), StatusCode::OK).await;
    assert_eq!(cancelled["status"], "cancelled");
    app.shutdown().await;
}
