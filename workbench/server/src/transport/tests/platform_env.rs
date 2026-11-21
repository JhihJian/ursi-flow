use super::*;
use std::os::unix::fs::PermissionsExt;

#[tokio::test]
async fn manages_only_names_and_never_echoes_submitted_values() {
    let f = Fixture::new("test-token");
    let path = "/api/v2/platform-env";
    let entry = format!("{path}/GITHUB_PAT_TOKEN");
    let secret = "sample-secret";
    let create = json!({"name":"GITHUB_PAT_TOKEN", "value":secret});
    for (method, target, body) in [
        ("GET", path, Value::Null),
        ("POST", path, create.clone()),
        ("PUT", &entry, json!({"value":secret})),
        ("DELETE", &entry, Value::Null),
    ] {
        assert_eq!(f.request(method, target, "", body).await.0, 401);
    }
    for (method, target, body, expected) in [
        ("GET", path, Value::Null, 200),
        ("PUT", &entry, json!({"value":secret}), 404),
        ("POST", path, json!({"name":"bad", "value":secret}), 400),
        ("POST", path, json!({"name":"KEY", "value":""}), 400),
        (
            "POST",
            path,
            json!({"name":"KEY", "value":"x".repeat(8193)}),
            400,
        ),
        (
            "POST",
            path,
            json!({"name":"KEY", "value":1, secret:secret}),
            400,
        ),
        ("POST", path, create.clone(), 200),
        ("POST", path, create, 409),
        ("PUT", &entry, json!({"value":"rotated-sample-secret"}), 200),
        ("GET", &entry, Value::Null, 405),
    ] {
        let (status, _, result) = f.request(method, target, AUTH, body).await;
        assert_eq!(status, expected, "{method} {target}");
        assert!(!result.contains(secret));
    }
    let (_, _, list) = f.request("GET", path, AUTH, Value::Null).await;
    assert_eq!(
        serde_json::from_str::<Value>(&list).unwrap(),
        json!(["GITHUB_PAT_TOKEN"])
    );
    let db = f.root.join("work/work.json");
    assert_eq!(
        fs::metadata(db).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(f.request("DELETE", &entry, AUTH, Value::Null).await.0, 200);
    assert_eq!(f.request("DELETE", &entry, AUTH, Value::Null).await.0, 404);
    assert_eq!(f.request("GET", path, AUTH, Value::Null).await.2, "[]");
}

#[tokio::test]
async fn page_binding_registers_without_file_and_never_uses_host_secret() {
    let f = Fixture::new("test-token");
    let path = "/api/v2/mcp-servers";
    let config = json!({"binding":"platform","name":"github","url":"https://api.githubcopilot.com/mcp/","credentialEnv":"HOME"});
    assert_eq!(f.request("POST", path, "", config.clone()).await.0, 401);
    assert_eq!(f.request("POST", path, AUTH, config.clone()).await.0, 400);
    assert_eq!(
        f.request(
            "POST",
            "/api/v2/platform-env",
            AUTH,
            json!({"name":"HOME","value":"fixture-token"})
        )
        .await
        .0,
        200
    );
    let (status, _, body) = f.request("POST", path, AUTH, config.clone()).await;
    assert_eq!(status, 200);
    assert!(!body.contains("fixture-token"));
    let record: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(record["binding"], "platform");
    let inspect = format!("{path}/{}/inspection", record["id"].as_str().unwrap());
    let mut bad = config.clone();
    bad["url"] = json!("http://example.org/mcp");
    assert_eq!(f.request("POST", path, AUTH, bad).await.0, 400);
    assert_eq!(
        f.request("DELETE", "/api/v2/platform-env/HOME", AUTH, Value::Null)
            .await
            .0,
        200
    );
    let (status, _, body) = f.request("GET", &inspect, AUTH, Value::Null).await;
    assert_eq!(status, 503);
    assert!(body.contains("MCP 凭据不可用"));
    let anonymous = json!({"binding":"platform","name":"public","url":"https://example.org/mcp"});
    assert_eq!(
        f.request("POST", path, AUTH, anonymous.clone()).await.0,
        200
    );
    let policy = f.root.join("work/mcp-policy.json");
    fs::write(&policy, "[]").unwrap();
    fs::set_permissions(policy, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(f.request("POST", path, AUTH, anonymous).await.0, 400);
}

#[tokio::test]
async fn new_mcp_sessions_use_current_value_only_after_policy_check() {
    use axum::{
        Router,
        http::{HeaderMap, StatusCode},
        routing::post,
    };
    let f = Fixture::new("test-token");
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let peer = Router::new().route(
        "/mcp",
        post(move |h: HeaderMap| async move {
            tx.send(h["authorization"].clone()).unwrap();
            StatusCode::FORBIDDEN
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, peer).await.unwrap() });
    let policy = f.root.join("work/mcp-policy.json");
    // HOME supplies an existing deployment value, without changing any process env in the test.
    fs::write(
        &policy,
        json!([{"url":url,"credentialEnv":"HOME"}]).to_string(),
    )
    .unwrap();
    fs::set_permissions(&policy, fs::Permissions::from_mode(0o600)).unwrap();
    let (status, _, row) = f
        .request(
            "POST",
            "/api/v2/mcp-servers",
            AUTH,
            json!({"name":"test","url":url,"credentialEnv":"HOME"}),
        )
        .await;
    assert_eq!(status, 200);
    let row: Value = serde_json::from_str(&row).unwrap();
    let inspect = format!(
        "/api/v2/mcp-servers/{}/inspection",
        row["id"].as_str().unwrap()
    );
    let path = "/api/v2/platform-env";
    let entry = format!("{path}/HOME");
    for (method, target, input, expected) in [
        (
            "POST",
            path,
            json!({"name":"HOME","value":"first"}),
            "first".to_owned(),
        ),
        (
            "PUT",
            entry.as_str(),
            json!({"value":"second"}),
            "second".to_owned(),
        ),
        (
            "DELETE",
            entry.as_str(),
            Value::Null,
            std::env::var("HOME").unwrap(),
        ),
    ] {
        assert_eq!(f.request(method, target, AUTH, input).await.0, 200);
        assert_eq!(f.request("GET", &inspect, AUTH, Value::Null).await.0, 503);
        assert_eq!(received.try_recv().unwrap(), format!("Bearer {expected}"));
    }
    fs::remove_file(policy).unwrap();
    assert_eq!(f.request("GET", &inspect, AUTH, Value::Null).await.0, 400);
    assert!(received.try_recv().is_err());
    server.abort();
}
