use axum::{Json, Router, extract::Request, http::header, response::IntoResponse};
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode};
use serde_json::{Value, json};
use std::{
    fs,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    process::Command,
    time::{sleep, timeout},
};
use uuid::Uuid;

const WORKBENCH_TOKEN: &str = "browser-only";
const PLATFORM_TOKEN: &str = "platform-only";
const ATTEMPT: &str = "643318af-1615-49ec-8dfe-042acaaebaab";
const WAIT: Duration = Duration::from_secs(10);

struct DataDir(PathBuf);

impl DataDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("workbench-test-{}", Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn command(&self, addr: SocketAddr) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_ursi-server"));
        cmd.env_clear()
            .current_dir(&self.0)
            .env("URSI_DATA_DIR", &self.0)
            .env("URSI_API_TOKEN", WORKBENCH_TOKEN)
            .env("URSI_FLOW_ENABLED", "0")
            .env("URSI_LISTEN_ADDR", addr.to_string())
            .kill_on_drop(true);
        cmd
    }
}

impl Drop for DataDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

async fn checked(request: RequestBuilder, status: u16) -> Response {
    let res = request.send().await.unwrap();
    assert_eq!(res.status(), status, "{}", res.url());
    res
}

#[tokio::test]
async fn production_workbench_requires_platform_and_separates_directory_owners() {
    let data = DataDir::new();
    let ephemeral = SocketAddr::from(([127, 0, 0, 1], 0));
    let listener = TcpListener::bind(ephemeral).await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    for (url, token) in [
        (None, None),
        (Some(&origin), None),
        (None, Some(PLATFORM_TOKEN)),
    ] {
        let mut cmd = data.command(ephemeral);
        if let Some(url) = url {
            cmd.env("URSI_EXECUTOR_PLATFORM_URL", url);
        }
        if let Some(token) = token {
            cmd.env("URSI_EXECUTOR_PLATFORM_TOKEN", token);
        }
        let output = timeout(WAIT, cmd.output())
            .await
            .expect("server did not reject incomplete platform configuration")
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success() && stderr.contains("平台"),
            "unexpected startup result: {output:?}"
        );
    }

    let calls = Arc::new(Mutex::new(Vec::new()));
    let raw_id = Arc::new(OnceLock::<String>::new());
    let mock = Router::new().fallback({
        let calls = calls.clone();
        let raw_id = raw_id.clone();
        move |req: Request| {
            let path = req.uri().to_string();
            calls.lock().unwrap().push(format!("{} {path}", req.method()));
            let raw_id = raw_id.get().cloned();
            async move {
                if req.headers().get(header::AUTHORIZATION).and_then(|h| h.to_str().ok()) != Some("Bearer platform-only") {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                if req.method() == Method::GET && let Some(id) = raw_id {
                    if path == format!("/api/v2/executor-attempts/{ATTEMPT}") {
                        return Json(json!({"attemptId": ATTEMPT, "status": "succeeded", "artifactDirectoryRef": format!("artifacts:{ATTEMPT}"), "artifactDirectoryId": id})).into_response();
                    }
                    if path == format!("/api/v2/directories/{id}/file?path=note") {
                        return "platform file".into_response();
                    }
                }
                StatusCode::NOT_FOUND.into_response()
            }
        }
    });
    let upstream = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });

    let addr = TcpListener::bind(ephemeral)
        .await
        .unwrap()
        .local_addr()
        .unwrap();
    let mut server = data
        .command(addr)
        .env("URSI_EXECUTOR_PLATFORM_URL", origin)
        .env("URSI_EXECUTOR_PLATFORM_TOKEN", PLATFORM_TOKEN)
        .spawn()
        .unwrap();
    let api = format!("http://{addr}/api/v2");
    let client = Client::builder().no_proxy().timeout(WAIT).build().unwrap();
    let auth = |method, path: &str| {
        client
            .request(method, format!("{api}/{path}"))
            .bearer_auth(WORKBENCH_TOKEN)
    };
    timeout(WAIT, async {
        loop {
            if let Some(status) = server.try_wait().unwrap() {
                panic!("Workbench exited at startup: {status}");
            }
            match client.get(format!("{api}/directories")).send().await {
                Ok(res) => {
                    assert_eq!(res.status(), 401);
                    break;
                }
                Err(e) if e.is_connect() => sleep(Duration::from_millis(25)).await,
                Err(e) => panic!("readiness request failed: {e}"),
            }
        }
    })
    .await
    .expect("Workbench did not become ready");

    let local: Value = checked(auth(Method::POST, "directories").json(&json!({})), 200)
        .await
        .json()
        .await
        .unwrap();
    let id = local["id"].as_str().unwrap();
    // Deliberately give the upstream directory the same raw ID and filename as the local one.
    raw_id.set(id.to_owned()).unwrap();
    let local_file = format!("directories/{id}/file?path=note");
    checked(auth(Method::PUT, &local_file).body("local file"), 204).await;
    assert_eq!(
        checked(auth(Method::GET, &local_file), 200)
            .await
            .text()
            .await
            .unwrap(),
        "local file"
    );
    assert_eq!(
        checked(auth(Method::GET, "directories"), 200)
            .await
            .json::<Value>()
            .await
            .unwrap(),
        json!([{"id":id}])
    );
    assert!(
        calls.lock().unwrap().is_empty(),
        "local operations reached the platform"
    );

    let attempt = format!("executor-attempts/{ATTEMPT}");
    let view: Value = checked(auth(Method::GET, &attempt), 200)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(view["attemptId"], ATTEMPT);
    assert_eq!(view["artifactDirectoryRef"], format!("artifacts:{ATTEMPT}"));
    let handle = view["artifactDirectoryId"].as_str().unwrap();
    assert_eq!(handle, format!("platform-artifact-{ATTEMPT}"));
    let artifact = format!("directories/{handle}/file?path=note");
    assert_eq!(
        checked(auth(Method::GET, &artifact), 200)
            .await
            .text()
            .await
            .unwrap(),
        "platform file"
    );
    assert_eq!(
        *calls.lock().unwrap(),
        [
            format!("GET /api/v2/{attempt}"),
            format!("GET /api/v2/{attempt}"),
            format!("GET /api/v2/{local_file}")
        ]
    );
    calls.lock().unwrap().clear();

    for path in [&artifact, &local_file] {
        let url = format!("{api}/{path}");
        checked(client.get(&url), 401).await;
        checked(client.get(&url).bearer_auth(PLATFORM_TOKEN), 401).await;
    }
    for path in [
        "executors",
        "resources",
        "patches/config",
        "agent-backends/example/check",
    ] {
        let res = auth(Method::POST, path)
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert!(
            matches!(res.status().as_u16(), 404 | 405),
            "POST {path}: {}",
            res.status()
        );
    }
    assert!(
        calls.lock().unwrap().is_empty(),
        "rejected requests reached the platform: {calls:?}"
    );
    server.kill().await.unwrap();
    upstream.abort();
}
