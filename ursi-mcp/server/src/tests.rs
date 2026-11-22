use super::*;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{net::TcpListener, task::JoinHandle};

#[derive(Default)]
struct Memory(
    Mutex<std::collections::BTreeMap<String, ServerRecord>>,
    Mutex<Vec<RecognitionRule>>,
);
impl ServerRepository for Memory {
    fn list(&self) -> Result<Vec<ServerRecord>, Error> {
        Ok(self.0.lock().unwrap().values().cloned().collect())
    }
    fn get(&self, id: &str) -> Result<Option<ServerRecord>, Error> {
        Ok(self.0.lock().unwrap().get(id).cloned())
    }
    fn insert(&self, row: &ServerRecord) -> Result<(), Error> {
        let mut rows = self.0.lock().unwrap();
        if rows.len() >= MAX_SERVERS {
            return Err(invalid("最多登记 128 个 MCP 服务"));
        }
        rows.insert(row.id.clone(), row.clone());
        Ok(())
    }
    fn remove(&self, id: &str) -> Result<bool, Error> {
        Ok(self.0.lock().unwrap().remove(id).is_some())
    }
    fn replace_settings(&self, id: &str, s: &Settings) -> Result<bool, Error> {
        let mut rows = self.0.lock().unwrap();
        let Some(row) = rows.get_mut(id) else {
            return Ok(false);
        };
        row.config.settings = Some(s.clone());
        Ok(true)
    }
    fn record_protocol_check(&self, id: &str, check: &ProtocolCheck) -> Result<bool, Error> {
        let mut rows = self.0.lock().unwrap();
        let Some(row) = rows.get_mut(id) else {
            return Ok(false);
        };
        row.protocol_check = Some(check.clone());
        Ok(true)
    }
    fn recognition_rules(&self) -> Result<Vec<RecognitionRule>, Error> {
        Ok(self.1.lock().unwrap().clone())
    }
    fn replace_recognition_rules(&self, rules: &[RecognitionRule]) -> Result<(), Error> {
        *self.1.lock().unwrap() = rules.to_vec();
        for row in self.0.lock().unwrap().values_mut() {
            row.protocol_check = None;
        }
        Ok(())
    }
}
impl Credentials for Memory {
    fn lookup(&self, name: &str, _: Binding) -> Result<Option<String>, Error> {
        Ok((name == "FIXTURE_TOKEN").then(|| "fixture-token".into()))
    }
}

struct Fixture {
    dir: PathBuf,
    store: McpPlatform,
    server: JoinHandle<()>,
    url: String,
    calls: Arc<Mutex<Vec<String>>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        let _ = fs::remove_dir_all(&self.dir);
    }
}
impl Fixture {
    async fn new() -> Self {
        Self::with_mode(PolicyMode::Optional).await
    }
    async fn with_mode(mode: PolicyMode) -> Self {
        let dir = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir(&dir).unwrap();
        let memory = Arc::new(Memory::default());
        *memory.1.lock().unwrap() = default_recognition_rules();
        let store = McpPlatform::with_policy_mode(
            memory.clone(),
            memory,
            dir.join("mcp-policy.json"),
            "fixture-client",
            "1",
            mode,
        );
        let calls = Arc::new(Mutex::new(vec![]));
        let app = Router::new()
            .route(
                "/mcp",
                post(peer).delete(
                    |State(calls): State<Arc<Mutex<Vec<String>>>>, h: HeaderMap| async move {
                        assert_eq!(h["mcp-session-id"], "session");
                        assert_eq!(h["mcp-protocol-version"], "2025-06-18");
                        calls.lock().unwrap().push("DELETE".into());
                        StatusCode::NO_CONTENT
                    },
                ),
            )
            .with_state(calls.clone());
        let sock = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", sock.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(sock, app).await.unwrap() });
        Self {
            dir,
            store,
            calls,
            server,
            url,
        }
    }
    fn cfg(&self) -> Config {
        Config {
            name: "反馈".into(),
            url: self.url.clone(),
            credential_env: None,
            credential_secret: None,
            binding: Binding::Policy,
            settings: Default::default(),
        }
    }
    fn permit(&self) {
        self.policy(json!([{"url":self.url}]));
    }
    fn policy(&self, grants: Value) {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(self.dir.join("mcp-policy.json"))
            .unwrap();
        file.write_all(grants.to_string().as_bytes()).unwrap();
    }
    async fn add(&self) -> String {
        self.permit();
        self.store.register(self.cfg()).unwrap().id
    }
}
async fn peer(
    State(calls): State<Arc<Mutex<Vec<String>>>>,
    h: HeaderMap,
    Json(q): Json<Value>,
) -> Response {
    let method = q["method"].as_str().unwrap();
    calls.lock().unwrap().push(method.into());
    let reply = |result: Value| json!({"jsonrpc":"2.0","id":q["id"],"result":result});
    if method == "server/discover" {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if method == "initialize" {
        assert_eq!(q["params"]["clientInfo"]["name"], "fixture-client");
        assert_eq!(q["params"]["protocolVersion"], "2025-11-25");
        return ([("mcp-session-id","session")],Json(reply(json!({"protocolVersion":"2025-06-18","capabilities":{"resources":{}},"serverInfo":{"name":"fixture","version":"1"},"_meta":{"ursi/executorProtocol":"1"}})))).into_response();
    }
    assert_eq!(h["mcp-session-id"], "session");
    assert_eq!(h["mcp-protocol-version"], "2025-06-18");
    match method {
        "notifications/initialized" => StatusCode::ACCEPTED.into_response(),
        "resources/list" => {
            if q["params"]["cursor"].is_null() {
                Json(reply(
                    json!({"resources":[{"name":"周报","uri":"memo:a"}],"nextCursor":"next"}),
                ))
                .into_response()
            } else {
                assert_eq!(q["params"]["cursor"], "next");
                let result = reply(
                    json!({"resources":[{"name":"图","uri":"memo:b","mimeType":"image/png"}]}),
                );
                (
                    [("content-type", "text/event-stream")],
                    format!(": keepalive\n\nevent: message\r\ndata: {result}\r\n\r\n"),
                )
                    .into_response()
            }
        }
        "resources/read" if q["params"]["uri"] == "memo:a" => Json(reply(
            json!({"contents":[{"uri":"memo:a","text":"来自服务"},{"uri":"memo:a","blob":"AP8="}]}),
        ))
        .into_response(),
        "resources/read" if q["params"]["uri"] == "memo:ambiguous" => Json(reply(
            json!({"contents":[{"uri":"memo:a","text":"正文","blob":"AP8="}]}),
        ))
        .into_response(),
        "resources/read" if q["params"]["uri"] == "memo:oversize" => {
            let comments = ": keepalive\n\n".repeat(SNAPSHOT_LIMIT / 13 + 1);
            let result = reply(json!({"contents":[{"uri":"memo:a","text":"正文"}]}));
            (
                [("content-type", "text/event-stream")],
                format!("{comments}data: {result}\n\n"),
            )
                .into_response()
        }
        "resources/read" => Json(
            json!({"jsonrpc":"2.0","id":q["id"],"error":{"code":-32002,"message":"not found"}}),
        )
        .into_response(),
        _ => StatusCode::BAD_REQUEST.into_response(),
    }
}
#[tokio::test]
async fn api_discovers_live_pages_and_persists_without_credentials() {
    let f = Fixture::new().await;
    f.permit();
    let app = f.store.routes();
    let sock = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp-servers", sock.local_addr().unwrap());
    let http = tokio::spawn(async move { axum::serve(sock, app).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let row: Value = client
        .post(&url)
        .json(&f.cfg())
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(row["name"], "反馈");
    let endpoint = format!("{url}/{}", row["id"].as_str().unwrap());
    let rows: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
    assert_eq!(rows, json!([row]));
    let resources: Value = client
        .get(format!("{endpoint}/resources"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        resources,
        json!([{"name":"周报","uri":"memo:a"},{"name":"图","uri":"memo:b","mimeType":"image/png"}])
    );
    assert_eq!(
        *f.calls.lock().unwrap(),
        [
            "server/discover",
            "initialize",
            "notifications/initialized",
            "resources/list",
            "resources/list",
            "DELETE"
        ]
    );
    let report: Value = client
        .get(format!("{endpoint}/inspection"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        report["server"],
        json!({"name":"fixture","version":"1","title":null,"protocolVersion":"2025-06-18","discoveryMethod":"initialize","supportedVersions":null,"declaredCapabilities":{"resources":{}},"instructions":null,"capabilities":{"resources":true,"tools":false,"prompts":false}})
    );
    assert_eq!(report["resources"], resources);
    assert!(f.store.list().unwrap()[0].protocol_check.is_none());
    f.calls.lock().unwrap().clear();
    let check = f
        .store
        .check_protocol(row["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(check.status, ProtocolStatus::Legacy);
    assert!(check.labels.is_empty());
    assert_eq!(
        *f.calls.lock().unwrap(),
        [
            "server/discover",
            "initialize",
            "notifications/initialized",
            "DELETE"
        ]
    );
    fs::remove_file(f.dir.join("mcp-policy.json")).unwrap();
    assert!(
        !client
            .get(format!("{endpoint}/resources"))
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    assert!(
        client
            .delete(&endpoint)
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    assert_eq!(
        client
            .get(format!("{endpoint}/resources"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    http.abort();
}
#[tokio::test]
async fn api_reads_one_resource_for_preview_and_hides_remote_errors() {
    let f = Fixture::new().await;
    let id = f.add().await;
    let read = |uri: &'static str| f.store.preview(&id, uri);
    assert_eq!(
        read("memo:a").await.unwrap(),
        json!([{"uri":"memo:a","text":"来自服务"},{"uri":"memo:a","blob":"AP8="}])
    );
    let remote = read("memo:missing").await.unwrap_err();
    assert!(matches!(remote, Error::Unavailable(_)));
    assert!(!format!("{remote:?}").contains("not found"));
    assert!(read("  ").await.is_err());
    for uri in ["memo:ambiguous", "memo:oversize"] {
        assert!(matches!(read(uri).await, Err(Error::Unavailable(_))));
    }
}

#[tokio::test]
async fn admin_grants_bind_secret_to_exact_endpoint() {
    let f = Fixture::new().await;
    let mut cfg = f.cfg();
    assert!(policy::authorize(&f.store, &cfg).is_err());
    f.permit();
    cfg.credential_env = Some("URSI_API_TOKEN".into());
    assert!(policy::endpoint(&f.store, &cfg).is_err());
    cfg.credential_env = Some("FIXTURE_TOKEN".into());
    f.policy(json!([{"url":cfg.url,"credentialEnv":"FIXTURE_TOKEN"}]));
    let (_, h) = policy::endpoint(&f.store, &cfg).unwrap();
    assert!(h.unwrap().is_sensitive());
    let value = json!(f.store.register(cfg.clone()).unwrap());
    assert_eq!(value["credentialEnv"], "FIXTURE_TOKEN");
    assert_eq!(
        value,
        json!({"id":value["id"],"name":cfg.name,"url":cfg.url,"credentialEnv":"FIXTURE_TOKEN"})
    );
    let mut other = cfg.clone();
    other.url.push_str("/other");
    assert!(policy::authorize(&f.store, &other).is_err());
    fs::set_permissions(
        f.dir.join("mcp-policy.json"),
        fs::Permissions::from_mode(0o660),
    )
    .unwrap();
    assert!(policy::authorize(&f.store, &cfg).is_err());
    assert!(f.calls.lock().unwrap().is_empty());
}
#[tokio::test]
async fn inline_secret_registers_connects_and_never_echoes_back() {
    let f = Fixture::new().await;
    let mut cfg = f.cfg();
    cfg.credential_secret = Some("inline-token".into());
    // A direct secret needs a per-endpoint `allowSecret` grant and rejects plain HTTP.
    f.permit();
    assert!(policy::authorize(&f.store, &cfg).is_err());
    let https = Config { url: "https://mcp.example.org/mcp".into(), ..cfg.clone() };
    f.policy(json!([{"url":https.url,"allowSecret":true}]));
    assert!(f.store.register(https).is_ok());
    f.policy(json!([{"url":cfg.url,"allowSecret":true}]));
    let (_, h) = policy::endpoint(&f.store, &cfg).unwrap();
    assert!(h.unwrap().is_sensitive());
    cfg.credential_env = Some("FIXTURE_TOKEN".into());
    assert!(f.store.register(cfg).is_err());
    let mut cfg = f.cfg();
    cfg.credential_secret = Some("bad token".into());
    assert!(f.store.register(cfg).is_err());
    // Required policy mode blocks registration itself until the endpoint is granted.
    let strict = Fixture::with_mode(PolicyMode::Required).await;
    let mut gated = strict.cfg();
    gated.credential_secret = Some("inline-token".into());
    assert!(strict.store.register(gated.clone()).is_err());
    strict.policy(json!([{"url":gated.url,"allowSecret":true}]));
    assert!(strict.store.register(gated).is_ok());
    // API responses only mark presence; the value itself never echoes back.
    let mut cfg = f.cfg();
    cfg.credential_secret = Some("inline-token".into());
    let row = f.store.register(cfg).unwrap().redacted();
    assert_eq!(row["credentialSecret"], json!(true));
    // Storage keeps the value for outbound use; API views only mark presence.
    let value = serde_json::to_string(&f.store.list().unwrap().iter().map(ServerRecord::redacted).collect::<Vec<_>>()).unwrap();
    assert!(value.contains("credentialSecret"));
    assert!(!value.contains("inline-token"));
}
#[tokio::test]
async fn credentialed_request_never_follows_redirect() {
    let f = Fixture::new().await;
    let sock = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/start", sock.local_addr().unwrap());
    let target = f.url.clone();
    let (saw_tx, mut saw_rx) = tokio::sync::mpsc::channel(1);
    let app = Router::new().route(
        "/start",
        post(move |headers: HeaderMap| async move {
            let expected = "Bearer fixture-token";
            saw_tx
                .send(headers.get("authorization").is_some_and(|h| h == expected))
                .await
                .unwrap();
            axum::response::Redirect::temporary(&target)
        }),
    );
    let http = tokio::spawn(async move { axum::serve(sock, app).await.unwrap() });
    let cfg = Config {
        url,
        credential_env: Some("FIXTURE_TOKEN".into()),
        ..f.cfg()
    };
    f.policy(json!([{"url":cfg.url,"credentialEnv":"FIXTURE_TOKEN"}]));
    assert!(client::Session::open(&f.store, &cfg).await.is_err());
    assert!(saw_rx.try_recv().unwrap());
    assert!(f.calls.lock().unwrap().is_empty());
    http.abort();
}

#[test]
fn github_settings_build_only_dedicated_headers_on_exact_endpoint() {
    let mut s = operations::Settings {
        github_toolsets: vec!["repos".into(), "issues".into()],
        github_read_only: true,
        ..Default::default()
    };
    let url = reqwest::Url::parse("https://api.githubcopilot.com/mcp/").unwrap();
    let h = s.headers(&url).unwrap();
    assert_eq!(h["x-mcp-toolsets"], "repos,issues");
    assert_eq!(h["x-mcp-readonly"], "true");
    assert!(
        s.headers(&reqwest::Url::parse("https://example.org/mcp/").unwrap())
            .is_err()
    );
    s.github_toolsets.push("issues\r\nx-other".into());
    assert!(s.headers(&url).is_err());
}

#[tokio::test]
async fn catalog_errors_preserve_phase_not_remote_body() {
    let f = Fixture::new().await;
    let app = Router::new().route("/denied",post(|| async {(StatusCode::UNAUTHORIZED,"private fixture detail")})).route("/broken", post(|Json(q):Json<Value>| async move {
        match q["method"].as_str() {
            Some("server/discover") => StatusCode::BAD_REQUEST.into_response(),
            Some("initialize") => Json(json!({"jsonrpc":"2.0","id":q["id"],"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}})).into_response(),
            Some("notifications/initialized") => StatusCode::ACCEPTED.into_response(),
            Some("tools/list") => ([("content-type","application/json")],"private fixture detail").into_response(),
            _ => StatusCode::NOT_FOUND.into_response(),
        }
    }));
    let sock = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", sock.local_addr().unwrap());
    let peer = tokio::spawn(async move { axum::serve(sock, app).await.unwrap() });
    for (path, expected) in [
        (
            "denied",
            "MCP 会话建立失败：server/discover 收到远端 HTTP 401",
        ),
        (
            "broken",
            "MCP 目录第 1 页失败：tools/list 的响应不是有效 JSON",
        ),
    ] {
        let mut cfg = f.cfg();
        cfg.url = format!("{base}/{path}");
        f.policy(json!([{"url":cfg.url}]));
        let result = match client::Session::open(&f.store, &cfg).await {
            Err(e) => Err(e),
            Ok(s) => {
                let r = s.catalog(operations::Catalog::Tools).await;
                s.close().await;
                r
            }
        };
        let Error::Unavailable(reason) = result.unwrap_err() else {
            panic!("expected 503")
        };
        assert!(reason.contains(expected), "{reason}");
        assert!(!reason.contains("private fixture detail"));
    }
    peer.abort();
}

#[tokio::test]
async fn modern_discovery_reports_versions_and_skips_undeclared_resources() {
    use rmcp::model::{DiscoverResult, Implementation, ProtocolVersion, ServerCapabilities};
    let f = Fixture::new().await;
    let calls = f.calls.clone();
    let peer = Router::new().route(
        "/mcp",
        post(move |h: HeaderMap, Json(q): Json<Value>| {
            let calls = calls.clone();
            async move {
                let method = q["method"].as_str().unwrap();
                calls.lock().unwrap().push(method.into());
                if method != "server/discover" {
                    return StatusCode::BAD_REQUEST.into_response();
                }
                assert_eq!(h["mcp-protocol-version"], "2026-07-28");
                let result = DiscoverResult::new(
                    vec![ProtocolVersion::V_2026_07_28, ProtocolVersion::V_2025_11_25],
                    ServerCapabilities::default(),
                )
                .with_server_info(Implementation::new("modern-peer", "1"));
                Json(json!({"jsonrpc":"2.0","id":q["id"],"result":result})).into_response()
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut cfg = f.cfg();
    cfg.url = format!("http://{}/mcp", listener.local_addr().unwrap());
    f.policy(json!([{"url":cfg.url}]));
    let id = f.store.register(cfg).unwrap().id;
    let peer = tokio::spawn(async move { axum::serve(listener, peer).await.unwrap() });
    let report = f.store.inspect(&id).await.unwrap();
    assert_eq!(report["server"]["name"], "modern-peer");
    assert_eq!(report["server"]["discoveryMethod"], "server/discover");
    assert_eq!(
        report["server"]["supportedVersions"],
        json!(["2026-07-28", "2025-11-25"])
    );
    assert_eq!(report["resources"], json!([]));
    assert_eq!(*f.calls.lock().unwrap(), ["server/discover"]);
    peer.abort();
}

fn executor_discovery(id: &Value, declaration: Option<Value>) -> Value {
    let mut reply = json!({"jsonrpc":"2.0","id":id,"result":{
        "resultType":"complete","supportedVersions":["2026-07-28","2025-06-18"],
        "capabilities":{"tools":{},"resources":{}},"ttlMs":0,"cacheScope":"private",
        "_meta":{"io.modelcontextprotocol/serverInfo":{"name":"executor","version":"1"}}
    }});
    if let Some(declaration) = declaration {
        reply["result"]["_meta"]["ursi/executorProtocol"] = declaration;
    }
    reply
}

#[tokio::test]
async fn protocol_api_persists_only_successful_correlated_declarations() {
    let f = Fixture::new().await;
    let mode = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let requests = f.calls.clone();
    let peer = Router::new().route(
        "/mcp",
        post({
            let mode = mode.clone();
            move |Json(q): Json<Value>| {
                let requests = requests.clone();
                let mode = mode.clone();
                async move {
                    requests
                        .lock()
                        .unwrap()
                        .push(q["method"].as_str().unwrap().into());
                    match mode.load(std::sync::atomic::Ordering::Relaxed) {
                        0 => Json(executor_discovery(&q["id"], Some(json!("1")))).into_response(),
                        1 => {
                            let reply = executor_discovery(&q["id"], None);
                            (
                                [("content-type", "text/event-stream")],
                                format!("data: {reply}\n\n"),
                            )
                                .into_response()
                        }
                        2 => Json(executor_discovery(&q["id"], Some(json!(1)))).into_response(),
                        3 => Json(executor_discovery(&q["id"], Some(json!("2")))).into_response(),
                        4 => Json(executor_discovery(&json!("wrong-id"), Some(json!("1"))))
                            .into_response(),
                        _ => StatusCode::BAD_GATEWAY.into_response(),
                    }
                }
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut cfg = f.cfg();
    cfg.url = format!("http://{}/mcp", listener.local_addr().unwrap());
    f.policy(json!([{"url":cfg.url}]));
    let peer = tokio::spawn(async move { axum::serve(listener, peer).await.unwrap() });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let registry = format!("http://{}/mcp-servers", listener.local_addr().unwrap());
    let app = f.store.routes();
    let api = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut forged = json!(cfg);
    forged["protocolCheck"] = json!({"status":"declaredV1","checkedAt":1,"labels":["执行器 v1"]});
    assert_eq!(
        client
            .post(&registry)
            .json(&forged)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let row: Value = client
        .post(&registry)
        .json(&cfg)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let endpoint = format!("{registry}/{}/protocol-check", row["id"].as_str().unwrap());
    let list = || async {
        client
            .get(&registry)
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()
    };
    assert_eq!(list().await, json!([row]));
    assert!(row.get("protocolCheck").is_none());
    assert!(f.calls.lock().unwrap().is_empty());

    for (wire_case, status, labels) in [
        (0, "checked", json!(["执行器 v1"])),
        (4, "checked", json!([])),
        (5, "checked", json!([])),
        (1, "checked", json!([])),
        (2, "checked", json!([])),
        (3, "checked", json!([])),
    ] {
        mode.store(wire_case, std::sync::atomic::Ordering::Relaxed);
        let previous = list().await;
        let reply = client.post(&endpoint).send().await.unwrap();
        if wire_case >= 4 {
            assert_eq!(reply.status(), StatusCode::SERVICE_UNAVAILABLE, "关联不符或响应无效保留上次结果");
            assert_eq!(list().await, previous);
            continue;
        }
        let check: Value = reply.error_for_status().unwrap().json().await.unwrap();
        assert_eq!(check["status"], status);
        assert_eq!(check["labels"], labels);
        assert!(check["checkedAt"].as_u64().unwrap() > 0);
        assert_eq!(list().await[0]["protocolCheck"], check);
        drop(previous);
    }
    fs::remove_file(f.dir.join("mcp-policy.json")).unwrap();
    assert_eq!(
        client.post(&endpoint).send().await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(*f.calls.lock().unwrap(), ["server/discover"; 6]);
    api.abort();
    peer.abort();
}

#[tokio::test]
async fn recognition_rules_round_trip_and_recheck_under_new_labels() {
    let f = Fixture::new().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let calls = f.calls.clone();
    let peer = Router::new().route(
        "/mcp",
        post(move |Json(q): Json<Value>| {
            let calls = calls.clone();
            async move {
                calls.lock().unwrap().push(q["method"].as_str().unwrap().into());
                Json(executor_discovery(&q["id"], Some(json!("1"))))
            }
        }),
    );
    let mut cfg = f.cfg();
    cfg.url = format!("http://{}/mcp", listener.local_addr().unwrap());
    f.policy(json!([{"url":cfg.url}]));
    let id = f.store.register(cfg).unwrap().id;
    let peer = tokio::spawn(async move { axum::serve(listener, peer).await.unwrap() });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = f.store.routes();
    let api = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let rules_path = format!("{base}/mcp-recognition-rules");
    let get = || async {
        client
            .get(&rules_path)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()
    };
    let put = |body: Value| {
        let rules_path = rules_path.clone();
        let client = client.clone();
        async move {
            client
                .put(&rules_path)
                .json(&body)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        }
    };
    let seed = get().await;
    assert_eq!(seed, json!([{"id":"executor-v1","label":"执行器 v1","metaKey":"ursi/executorProtocol","equals":"1"}]));
    let endpoint = format!("{base}/mcp-servers/{id}/protocol-check");
    let check: Value = client
        .post(&endpoint)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(check["labels"], json!(["执行器 v1"]));
    let custom = json!([
        {"id":"executor-v1","label":"执行器 v1","metaKey":"ursi/executorProtocol","equals":"1"},
        {"id":"analysis","label":"分析服务","metaKey":"ursi/executorProtocol","equals":"1"},
        {"id":"empty","label":"永不匹配","metaKey":"ursi/serviceKind","equals":"analysis"}
    ]);
    assert_eq!(put(custom.clone()).await, custom);
    assert_eq!(get().await, custom);
    let row: Value = client
        .get(format!("{base}/mcp-servers"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(row[0].get("protocolCheck").is_none(), "保存规则须清除旧检查");
    let check: Value = client
        .post(&endpoint)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(check["labels"], json!(["执行器 v1", "分析服务"]));
    assert_eq!(put(json!([])).await, json!([]));
    let row: Value = client
        .get(format!("{base}/mcp-servers"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(row[0].get("protocolCheck").is_none());
    assert_eq!(get().await, json!([]));
    api.abort();
    peer.abort();
}

#[tokio::test]
async fn protocol_check_serializes_per_service_without_overwriting_settings_or_recreating_deleted_rows()
 {
    let f = Fixture::new().await;
    let (started, mut requests) = tokio::sync::mpsc::unbounded_channel();
    let peer = Router::new().route(
        "/mcp",
        post(move |Json(q): Json<Value>| {
            let started = started.clone();
            async move {
                assert_eq!(q["method"], "server/discover");
                let (send, wait) = tokio::sync::oneshot::channel();
                started.send(send).unwrap();
                wait.await.unwrap();
                Json(executor_discovery(&q["id"], Some(json!("1"))))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut cfg = f.cfg();
    cfg.url = format!("http://{}/mcp", listener.local_addr().unwrap());
    f.policy(json!([{"url":cfg.url}]));
    let record = f.store.register(cfg).unwrap();
    let id = &record.id;
    let peer = tokio::spawn(async move { axum::serve(listener, peer).await.unwrap() });
    let spawn_check = || {
        let (store, id) = (f.store.clone(), id.clone());
        tokio::spawn(async move { store.check_protocol(&id).await })
    };
    let checked = spawn_check();
    let release = timeout(Duration::from_secs(3), requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        f.store.check_protocol(id).await,
        Err(Error::Unavailable(_))
    ));
    let settings = Settings {
        allowed_tools: vec!["echo".into()],
        ..Settings::default()
    };
    f.store.replace_settings(id, settings.clone()).unwrap();
    release.send(()).unwrap();
    assert_eq!(
        checked.await.unwrap().unwrap().status,
        ProtocolStatus::Checked
    );
    assert_eq!(
        json!(f.store.list().unwrap()[0].config.settings),
        json!(settings)
    );

    let checked = spawn_check();
    let release = timeout(Duration::from_secs(3), requests.recv())
        .await
        .unwrap()
        .unwrap();
    f.store.remove(id).unwrap();
    release.send(()).unwrap();
    assert!(matches!(checked.await.unwrap(), Err(Error::NotFound(_))));
    assert!(f.store.list().unwrap().is_empty());
    peer.abort();
}

#[tokio::test]
async fn operation_uses_one_slot_for_multiple_reads_and_shares_with_preview() {
    let f = Fixture::new().await;
    let id = f.add().await;
    let mut conversion = f.store.operation().unwrap();
    let other = f.store.clone();
    let held: Vec<_> = (0..3).map(|_| other.operation().unwrap()).collect();
    assert!(matches!(
        other.preview(&id, "memo:a").await,
        Err(Error::Unavailable(_))
    ));
    assert!(f.calls.lock().unwrap().is_empty());
    for _ in 0..2 {
        assert_eq!(
            conversion.read_resource(&id, "memo:a").await.unwrap()[0]["text"],
            "来自服务"
        );
    }
    drop(held);
    assert!(other.preview(&id, "memo:a").await.is_ok());
}

#[tokio::test]
async fn revoked_tool_is_not_sent_after_handshake() {
    let f = Fixture::new().await;
    let (ready, mut started) = tokio::sync::mpsc::unbounded_channel();
    let resume = Arc::new(tokio::sync::Notify::new());
    let resume_peer = resume.clone();
    let peer = Router::new().route("/mcp", post(move |Json(q): Json<Value>| {
        let ready = ready.clone();
        let resume = resume_peer.clone();
        async move {
            match q["method"].as_str().unwrap() {
                "server/discover" => StatusCode::BAD_REQUEST.into_response(),
                "initialize" => {
                    ready.send("initialize").unwrap();
                    resume.notified().await;
                    Json(json!({"jsonrpc":"2.0","id":q["id"],"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}})).into_response()
                }
                "notifications/initialized" => StatusCode::ACCEPTED.into_response(),
                "tools/call" => {
                    ready.send("tools/call").unwrap();
                    StatusCode::BAD_REQUEST.into_response()
                }
                _ => StatusCode::NOT_FOUND.into_response(),
            }
        }
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut cfg = f.cfg();
    cfg.url = format!("http://{}/mcp", listener.local_addr().unwrap());
    f.policy(json!([{"url":cfg.url,"allowedTools":["echo"]}]));
    cfg.settings = Some(Settings {
        allowed_tools: vec!["echo".into()],
        ..Settings::default()
    });
    let id = f.store.register(cfg).unwrap().id;
    let peer = tokio::spawn(async move { axum::serve(listener, peer).await.unwrap() });
    let platform = f.store.clone();
    let call_id = id.clone();
    let call = tokio::spawn(async move {
        platform
            .call_tool(
                &call_id,
                Input {
                    name: "echo".into(),
                    arguments: Default::default(),
                },
            )
            .await
    });
    assert_eq!(
        timeout(Duration::from_secs(5), started.recv())
            .await
            .unwrap(),
        Some("initialize")
    );
    f.store.replace_settings(&id, Settings::default()).unwrap();
    resume.notify_one();
    assert!(matches!(call.await.unwrap(), Err(Error::Invalid(s)) if s == "此工具尚未授权调用"));
    assert!(started.try_recv().is_err());
    peer.abort();
}

#[tokio::test]
async fn file_policy_is_a_separate_ceiling_on_tool_calls() {
    let f = Fixture::new().await;
    f.permit();
    let cfg = f.cfg();
    assert!(policy::authorize_operation(&f.store, &cfg, Some("echo")).is_err());
    f.policy(json!([{"url":cfg.url,"allowedTools":["echo"]}]));
    assert!(policy::authorize_operation(&f.store, &cfg, Some("echo")).is_ok());
    assert!(policy::authorize_operation(&f.store, &cfg, Some("write")).is_err());
}


