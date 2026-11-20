use super::*;
use axum::{
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

struct Fixture {
    dir: PathBuf,
    store: Store,
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
        let dir = std::env::temp_dir().join(Uuid::new_v4().to_string());
        let store = Store::open(dir.clone()).unwrap();
        let calls = Arc::new(Mutex::new(vec![]));
        let app = Router::new()
            .route(
                "/mcp",
                post(peer).delete(|| async { StatusCode::NO_CONTENT }),
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
        register(State(self.store.clone()), Json(self.cfg()))
            .await
            .unwrap()
            .0["id"]
            .as_str()
            .unwrap()
            .to_string()
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
    if method == "initialize" {
        assert_eq!(q["params"]["clientInfo"]["name"], "ursi-workbench");
        return ([("mcp-session-id","session")],Json(reply(json!({"protocolVersion":"2025-06-18","capabilities":{"resources":{}},"serverInfo":{"name":"fixture","version":"1"}})))).into_response();
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
        "resources/read" => Json(
            json!({"jsonrpc":"2.0","id":q["id"],"error":{"code":-32002,"message":"not found"}}),
        )
        .into_response(),
        _ => StatusCode::BAD_REQUEST.into_response(),
    }
}
fn item(id: &str, uri: &str, script: &str) -> Value {
    json!({"id":"i","title":"本周","description":"","category":"active","revision":3,"recipe":{"script":script,"resources":[{"alias":"note","serverId":id,"uri":uri}]}})
}

#[tokio::test]
async fn api_discovers_live_pages_and_persists_without_credentials() {
    let f = Fixture::new().await;
    f.permit();
    let app = routes(f.store.clone());
    let sock = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v2/mcp-servers", sock.local_addr().unwrap());
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
            "initialize",
            "notifications/initialized",
            "resources/list",
            "resources/list"
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
async fn admin_grants_bind_secret_to_exact_endpoint() {
    let f = Fixture::new().await;
    let mut cfg = f.cfg();
    assert!(policy::authorize(&f.store, &cfg).is_err());
    f.permit();
    cfg.credential_env = Some("URSI_API_TOKEN".into());
    assert!(policy::endpoint(&f.store, &cfg).is_err());
    // HOME is a non-secret fixture for checking the authorized reference without mutating process env.
    cfg.credential_env = Some("HOME".into());
    f.policy(json!([{"url":cfg.url,"credentialEnv":"HOME"}]));
    let (_, h) = policy::endpoint(&f.store, &cfg).unwrap();
    assert!(h.unwrap().is_sensitive());
    let value = register(State(f.store.clone()), Json(cfg.clone()))
        .await
        .unwrap()
        .0;
    assert_eq!(value["credentialEnv"], "HOME");
    assert_eq!(
        value,
        json!({"id":value["id"],"name":cfg.name,"url":cfg.url,"credentialEnv":"HOME"})
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
async fn read_error_and_missing_sandbox_are_terminal() {
    let f = Fixture::new().await;
    let id = f.add().await;
    let result = convert(&f.store, &item(&id, "memo:missing", "raise Exception()")).await;
    assert!(matches!(result,Err(Error::Unavailable(s)) if s.contains("memo:missing")));
    assert!(matches!(
        sandbox::execute("/nonexistent/bwrap", &json!({})).await,
        Err(Error::Unavailable(_))
    ));
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
            let expected = format!("Bearer {}", std::env::var("HOME").unwrap());
            saw_tx
                .send(
                    headers
                        .get("authorization")
                        .is_some_and(|h| h == expected.as_str()),
                )
                .await
                .unwrap();
            axum::response::Redirect::temporary(&target)
        }),
    );
    let http = tokio::spawn(async move { axum::serve(sock, app).await.unwrap() });
    let cfg = Config {
        url,
        credential_env: Some("HOME".into()),
        ..f.cfg()
    };
    f.policy(json!([{"url":cfg.url,"credentialEnv":"HOME"}]));
    assert!(client::Session::open(&f.store, &cfg).await.is_err());
    assert!(saw_rx.try_recv().unwrap());
    assert!(f.calls.lock().unwrap().is_empty());
    http.abort();
}

#[test]
fn rejects_invalid_package_wholesale() {
    let ok = json!({"path":"有效/a","text":"hi"});
    for bad in [
        ok.clone(),
        json!({"path":"有效","text":""}),
        json!({"path":"有效/a/b","text":""}),
        json!({"path":"../a","text":""}),
        json!({"path":"a","blob":"!"}),
        json!({"path":"a","text":"","blob":null}),
    ] {
        assert!(package(json!({"name":"结果","files":[ok,bad]}), Value::Null).is_err());
    }
    assert!(package(json!({"name":"结果","files":vec![ok;129]}), Value::Null).is_err());
}
#[tokio::test]
#[ignore = "需要可用的 Linux bwrap 用户命名空间与 libseccomp"]
async fn isolated_live_read_to_files() {
    let f = Fixture::new().await;
    let id = f.add().await;
    let script = "def transform(item, resources):\n p=resources['note']['contents']\n return {'name':item['title'],'files':[{'path':'材料/a','text':p[0]['text']},{'path':'b','blob':p[1]['blob']}]}";
    let g = convert(&f.store, &item(&id, "memo:a", script))
        .await
        .unwrap();
    assert_eq!(g.name, "本周");
    assert_eq!(
        g.files,
        vec![
            ("材料/a".into(), "来自服务".as_bytes().to_vec()),
            ("b".into(), vec![0, 255])
        ]
    );
    assert_eq!(g.provenance["revision"], 3);
    assert_eq!(g.provenance["resources"][0]["serverId"], id);
    assert!(g.provenance["resources"][0]["readAt"].as_u64().is_some());
    assert_eq!(
        g.provenance["scriptSha256"],
        format!("{:x}", Sha256::digest(script))
    );
}
#[tokio::test]
#[ignore = "需要可用的 Linux bwrap 用户命名空间与 libseccomp"]
async fn isolated_script_has_no_host_files_processes_or_unbounded_output() {
    let probe = "def transform(i,r):\n import ctypes, errno\n libc=ctypes.CDLL(None,use_errno=True)\n return libc.socket(2,1,0) == -1 and ctypes.get_errno() == errno.EPERM";
    let input = json!({"item":{}, "resources":{}, "script":probe});
    assert_eq!(sandbox::run(&input).await.unwrap(), json!(true));
    for command in [
        "open('/usr/bin/python3', 'rb')",
        "import os; os.fork()",
        "import os; assert 'HOME' in os.environ",
        "raise RuntimeError('private')",
        "while True: pass",
        "return 'x' * (7 << 20)",
    ] {
        let v =
            json!({"item":{},"resources":{},"script":format!("def transform(i,r):\n {command}")});
        assert!(
            matches!(sandbox::run(&v).await, Err(Error::Invalid(_))),
            "{command}"
        );
    }
}
