use super::*;
use crate::work::{catalog, execute, items};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    task::JoinHandle,
};
use uuid::Uuid;

const LIST: &str = "/v2/sources/tickets/items";
const DETAIL: &str = "/v2/sources/tickets/items/T-1";
const DISPATCH: &str = "/v2/sources/tickets/items/T-1/dispatch";

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    fn store(&self) -> Store {
        Store::open(self.path("work")).unwrap()
    }
    fn config(&self) -> Value {
        json!({"providers":[{"id":"tickets","kind":"json-file","file":self.path("export"),"actions":[{"action":"inspect","package":"triage","revision":1}]}]})
    }
    fn write(&self, name: &str, data: &str) {
        let mut f = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(self.path(name))
            .unwrap();
        f.write_all(data.as_bytes()).unwrap();
    }
    fn export(&self, ticket: &str) {
        self.write(
            "export",
            &json!([{"id":"T-1","title":ticket,"input":{"ticket":ticket}}]).to_string(),
        );
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Http {
    dir: Temp,
    task: JoinHandle<()>,
}
impl Drop for Http {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Http {
    fn new(enabled: bool) -> Self {
        let dir = Temp::new();
        let store = dir.store();
        dir.write("config", &dir.config().to_string());
        dir.export("first");
        let cfg = dir.path("config");
        let app = configured(store.clone(), enabled.then_some(cfg.as_path()))
            .unwrap()
            .merge(catalog::routes(store.clone()))
            .merge(items::routes(store.clone()))
            .merge(execute::routes(store, dir.0.clone(), None));
        let listener = UnixListener::bind(dir.path("http.sock")).unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { dir, task }
    }
    async fn request(&self, method: &str, path: &str, body: Value) -> (u16, String) {
        let mut socket = UnixStream::connect(self.dir.path("http.sock"))
            .await
            .unwrap();
        let text = if body.is_null() {
            String::new()
        } else {
            body.to_string()
        };
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}",
            text.len()
        );
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).await.unwrap();
        let (header, body) = response.split_once("\r\n\r\n").unwrap();
        (
            header.split_whitespace().nth(1).unwrap().parse().unwrap(),
            body.to_owned(),
        )
    }
    async fn ok(&self, method: &str, path: &str, body: Value) -> Value {
        let (status, text) = self.request(method, path, body).await;
        assert_eq!(status, 200, "{text}");
        serde_json::from_str(&text).unwrap()
    }
    async fn publish(&self) {
        self.ok("POST", "/v2/executors", json!({"id":"flow"})).await;
        let binding = json!({"executor":{"id":"flow","revision":1}});
        let package = json!({"id":"triage","sop":"read","acceptance":"review","actions":{"inspect":binding,"other":binding}});
        self.ok("POST", "/v2/packages", package.clone()).await;
        self.ok("POST", "/v2/packages", package).await;
    }
}

#[tokio::test]
async fn refresh_and_concurrent_dispatch_pin_material_version_and_action() {
    let app = Http::new(true);
    app.publish().await;
    assert_eq!(
        app.ok("GET", "/v2/sources", Value::Null).await,
        json!([{"id":"tickets","kind":"json-file","actions":["inspect"]}])
    );
    assert_eq!(
        app.ok("GET", LIST, Value::Null).await,
        json!([{"id":"T-1","title":"first"}])
    );
    app.dir.export("second");
    assert_eq!(
        app.ok("GET", DETAIL, Value::Null).await,
        json!({"id":"T-1","title":"second","actions":["inspect"],"input":{"ticket":"second"}})
    );
    app.dir.export("third");
    let req = json!({"requestId":"same","action":"inspect"});
    let (a, b) = tokio::join!(
        app.ok("POST", DISPATCH, req.clone()),
        app.ok("POST", DISPATCH, req.clone())
    );
    assert_eq!(a, b);
    assert_eq!(a["status"], "pending");
    let item_path = format!("/v2/items/{}", a["id"].as_str().unwrap());
    let work = app.ok("GET", &item_path, Value::Null).await;
    assert_eq!(
        work["source"],
        json!({"type":"connector","provider":"tickets","itemId":"T-1","action":"inspect"})
    );
    assert_eq!(work["input"], json!({"ticket":"third"}));
    assert_eq!(work["package"], "triage");
    assert_eq!(work["revision"], 1);
    assert_eq!(work["attempts"], json!([]));
    app.ok(
        "POST",
        &format!("{item_path}/start"),
        json!({"assignee":"reviewer"}),
    )
    .await;
    let attempts = format!("{item_path}/attempts");
    assert!(
        (400..500).contains(
            &app.request("POST", &attempts, json!({"action":"other"}))
                .await
                .0
        )
    );
    assert_eq!(app.ok("GET", &attempts, Value::Null).await, json!([]));
    app.dir.export("fourth");
    assert_eq!(app.request("POST", DISPATCH, req).await.0, 409);
    assert_eq!(
        app.ok("GET", "/v2/items", Value::Null)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn rejects_overrides_and_unavailable_or_removed_resources() {
    let app = Http::new(true);
    let req = json!({"requestId":"new","action":"inspect"});
    for key in ["package", "revision", "input", "executor", "source", "file"] {
        let mut bad = req.clone();
        bad[key] = "override".into();
        assert_eq!(app.request("POST", DISPATCH, bad).await.0, 422);
    }
    assert_eq!(
        app.request(
            "POST",
            DISPATCH,
            json!({"requestId":"new","action":"other"})
        )
        .await
        .0,
        400
    );
    app.dir.write("export", "[]");
    assert_eq!(app.request("POST", DISPATCH, req.clone()).await.0, 404);
    for raw in [
        "private-malformed-value".into(),
        "x".repeat(file::EXPORT_LIMIT as usize + 1),
        json!([{"id":"A","title":"one","input":{}},{"id":"A","title":"two","input":{}}])
            .to_string(),
    ] {
        app.dir.write("export", &raw);
        let (status, text) = app.request("POST", DISPATCH, req.clone()).await;
        assert_eq!(status, 503);
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            json!({"error":"来源导出文件不可用"})
        );
    }
    fs::remove_file(app.dir.path("export")).unwrap();
    symlink(app.dir.path("config"), app.dir.path("export")).unwrap();
    assert_eq!(app.request("GET", LIST, Value::Null).await.0, 503);
    assert_eq!(app.ok("GET", "/v2/items", Value::Null).await, json!([]));
}

#[tokio::test]
async fn disabled_sources_leave_builtin_routes_available() {
    let app = Http::new(false);
    assert_eq!(app.request("GET", "/v2/sources", Value::Null).await.0, 404);
    assert_eq!(app.ok("GET", "/v2/items", Value::Null).await, json!([]));
}

#[test]
fn invalid_configuration_is_rejected_at_mount() {
    let dir = Temp::new();
    let store = dir.store();
    let path = dir.path("config");
    let mut cfg = dir.config();
    for (key, bad) in [
        ("kind", json!("http")),
        ("file", json!("relative")),
        (
            "actions",
            json!([{"action":"inspect","package":"triage","revision":0}]),
        ),
    ] {
        let mut broken = cfg.clone();
        broken["providers"][0][key] = bad;
        dir.write("config", &broken.to_string());
        assert!(configured(store.clone(), Some(&path)).is_err());
    }
    let first = cfg["providers"][0].clone();
    cfg["providers"].as_array_mut().unwrap().push(first);
    dir.write("config", &cfg.to_string());
    assert!(configured(store.clone(), Some(&path)).is_err());
    dir.write("config", &"x".repeat(file::CONFIG_LIMIT as usize + 1));
    assert!(configured(store.clone(), Some(&path)).is_err());
    dir.write("config", &dir.config().to_string());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(configured(store, Some(&path)).is_err());
}
