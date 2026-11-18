use super::*;
use serde_json::{Value, json};
use std::{fs, io, path::PathBuf};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    task::JoinHandle,
};
use ursi_flow_client::FlowClient;
use uuid::Uuid;

// 测试 HTTP 与 SDK 均走私有的 Unix socket，不监听网络端口。
struct Fixture {
    root: PathBuf,
    server: JoinHandle<()>,
    runtime: JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        self.runtime.abort();
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    fn new(token: &str) -> Self {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let socket = root.join("runtime.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let runtime = tokio::spawn(async move {
            loop {
                let (mut conn, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                conn.read_to_end(&mut bytes).await.unwrap();
                let req: Value = serde_json::from_slice(&bytes).unwrap();
                let data = if req["op"] == "flow.list" {
                    json!(["f"])
                } else {
                    req
                };
                conn.write_all(json!({"v":1,"data":data}).to_string().as_bytes())
                    .await
                    .unwrap();
            }
        });
        let service = FlowService::new(
            crate::flow::FlowClient::new(FlowClient::new(socket)),
            root.clone(),
        );
        let app = router(service, token.into());
        let listener = UnixListener::bind(root.join("http.sock")).unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            root,
            server,
            runtime,
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        auth: &str,
        body: Value,
    ) -> (u16, String, String) {
        let mut conn = UnixStream::connect(self.root.join("http.sock"))
            .await
            .unwrap();
        let text = if body.is_null() {
            String::new()
        } else {
            body.to_string()
        };
        let wire = format!(
            "{method} {path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}",
            text.len()
        );
        conn.write_all(wire.as_bytes()).await.unwrap();
        let mut response = String::new();
        conn.read_to_string(&mut response).await.unwrap();
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        (
            headers.split_whitespace().nth(1).unwrap().parse().unwrap(),
            headers.to_owned(),
            body.to_owned(),
        )
    }
    async fn api(&self, method: &str, path: &str, body: Value) -> Value {
        let (status, _, text) = self
            .request(method, &format!("/api/v1{path}"), AUTH, body)
            .await;
        assert_eq!(status, 200, "{method} {path}: {text}");
        serde_json::from_str(&text).unwrap()
    }
}
const AUTH: &str = "Authorization: Bearer test-token\r\n";

#[tokio::test]
async fn http_forwards_sdk_operations_and_returns_raw_data() {
    let app = Fixture::new("test-token");
    assert_eq!(app.api("GET", "/flows", Value::Null).await, json!(["f"]));
    let files = json!({"FLOW.md":"演示\n"});
    let package = json!({"id":"f", "files":files});
    let patch = json!({"maxConcurrent":2});
    for (method, path, body, op, args) in [
        (
            "POST",
            "/flows",
            package.clone(),
            "flow.create",
            package.clone(),
        ),
        (
            "POST",
            "/flows/validate",
            package.clone(),
            "flow.validate",
            package,
        ),
        (
            "GET",
            "/flows/f",
            Value::Null,
            "flow.get",
            json!({"id":"f"}),
        ),
        (
            "GET",
            "/flows/validate",
            Value::Null,
            "flow.get",
            json!({"id":"validate"}),
        ),
        (
            "PUT",
            "/flows/f",
            json!({"files":files,"expectedRevision":"r0"}),
            "flow.update",
            json!({"files":files,"id":"f","expectedRevision":"r0"}),
        ),
        (
            "PUT",
            "/flows/f",
            json!({"files":files}),
            "flow.update",
            json!({"files":files,"id":"f"}),
        ),
        (
            "DELETE",
            "/flows/f",
            Value::Null,
            "flow.delete",
            json!({"id":"f"}),
        ),
        ("GET", "/runs", Value::Null, "run.list", json!({})),
        ("GET", "/runs/r", Value::Null, "run.get", json!({"id":"r"})),
        (
            "GET",
            "/runs/r/history",
            Value::Null,
            "run.history",
            json!({"id":"r"}),
        ),
        (
            "POST",
            "/runs/r/stop",
            Value::Null,
            "run.stop",
            json!({"id":"r"}),
        ),
        ("GET", "/flow-config", Value::Null, "config.get", json!({})),
        (
            "PATCH",
            "/flow-config",
            patch.clone(),
            "config.update",
            patch,
        ),
    ] {
        assert_eq!(
            app.api(method, path, body).await,
            json!({"v":1,"op":op,"args":args}),
            "{method} {path}"
        );
    }
}

#[tokio::test]
async fn start_maps_default_and_forwards_or_generates_run_id() {
    let app = Fixture::new("test-token");
    let mut body =
        json!({"workspace":"default","variables":{"n":1,"list":[false]},"runId":"chosen"});
    for generated in [false, true] {
        if generated {
            body.as_object_mut().unwrap().remove("runId");
        }
        let req = app.api("POST", "/flows/f/runs", body.clone()).await;
        assert_eq!(req["op"], "run.start");
        let args = &req["args"];
        assert_eq!(args["cwd"], json!(app.root.canonicalize().unwrap()));
        assert_eq!(args["flow"], "f");
        assert_eq!(args["variables"], body["variables"]);
        if generated {
            Uuid::parse_str(args["id"].as_str().unwrap()).unwrap();
        } else {
            assert_eq!(args["id"], "chosen");
        }
    }
    for bad in [
        json!({"workspace":"/tmp","variables":{}}),
        json!({"workspace":"default","variables":{},"cwd":"/tmp"}),
        json!({"workspace":"default","variables":[]}),
    ] {
        assert!(
            (400..500).contains(
                &app.request("POST", "/api/v1/flows/f/runs", AUTH, bad)
                    .await
                    .0
            )
        );
    }
}

#[tokio::test]
async fn api_auth_includes_fallback_and_method_rejections() {
    let app = Fixture::new("test-token");
    for path in [
        "/api",
        "/api/",
        "/api/missing",
        "/api/v1/flows",
        "/api/v1/flows/typo/missing",
    ] {
        for auth in [
            "",
            "Authorization: Basic test-token\r\n",
            "Authorization: Bearer wrong\r\n",
            &AUTH.repeat(2),
        ] {
            let (status, headers, _) = app.request("GET", path, auth, Value::Null).await;
            assert_eq!(status, 401, "{path}");
            assert!(
                headers
                    .to_ascii_lowercase()
                    .contains("www-authenticate: bearer")
            );
        }
        if path != "/api/v1/flows" {
            let (status, _, body) = app.request("GET", path, AUTH, Value::Null).await;
            assert_eq!(status, 404, "{path}");
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap()["error"]["code"],
                "not_found"
            );
        }
    }
    assert_eq!(
        app.request("DELETE", "/api/v1/runs", "", Value::Null)
            .await
            .0,
        401
    );
    assert_eq!(
        app.request("DELETE", "/api/v1/runs", AUTH, Value::Null)
            .await
            .0,
        405
    );
    let empty = Fixture::new("");
    assert_eq!(
        empty
            .request(
                "GET",
                "/api/v1/flows",
                "Authorization: Bearer \r\n",
                Value::Null
            )
            .await
            .0,
        401
    );
}

#[tokio::test]
async fn non_api_paths_are_not_served() {
    let app = Fixture::new("test-token");
    for path in ["/", "/runs/r", "/app.js"] {
        assert_eq!(app.request("GET", path, "", Value::Null).await.0, 404);
    }
}

#[tokio::test]
async fn maps_sdk_errors_without_exposing_messages() {
    use io::ErrorKind::*;
    for (kind, status) in [
        (NotFound, 404),
        (InvalidInput, 400),
        (AlreadyExists, 409),
        (WouldBlock, 429),
        (ConnectionRefused, 503),
        (TimedOut, 504),
        (InvalidData, 502),
        (Other, 500),
    ] {
        let response = error::ApiError::from(io::Error::new(kind, "secret-path")).into_response();
        assert_eq!(response.status().as_u16(), status);
        let bytes = axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap();
        assert!(!std::str::from_utf8(&bytes).unwrap().contains("secret-path"));
    }
}
