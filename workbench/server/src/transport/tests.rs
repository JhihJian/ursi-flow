use super::*;
use serde_json::Value;
use std::{fs, path::PathBuf};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    task::JoinHandle,
};
use uuid::Uuid;

// 测试 HTTP 走私有 Unix socket，不监听网络端口。
struct Fixture {
    root: PathBuf,
    server: JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    fn new(token: &str) -> Self {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let store = ursi_executor_platform::work::Store::open(root.join("work")).unwrap();
        let work = crate::work::business_routes(store).unwrap();
        let app = router(work, token.into());
        let listener = UnixListener::bind(root.join("http.sock")).unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { root, server }
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
}

const AUTH: &str = "Authorization: Bearer test-token\r\n";

#[tokio::test]
async fn api_auth_includes_fallback_and_method_rejections() {
    let app = Fixture::new("test-token");
    for path in ["/api", "/api/", "/api/missing"] {
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
        let (status, _, body) = app.request("GET", path, AUTH, Value::Null).await;
        assert_eq!(status, 404, "{path}");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["error"]["code"],
            "not_found"
        );
    }
    // 已挂载路径的方法不匹配返回 405，未挂载路径仍是 404。
    assert_eq!(
        app.request("DELETE", "/api/v2/platform-env", "", Value::Null)
            .await
            .0,
        401
    );
    assert_eq!(
        app.request("DELETE", "/api/v2/platform-env", AUTH, Value::Null)
            .await
            .0,
        405
    );
    let empty = Fixture::new("");
    assert_eq!(
        empty
            .request(
                "GET",
                "/api/v2/platform-env",
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
    for path in ["/", "/v2/platform-env", "/app.js"] {
        assert_eq!(app.request("GET", path, "", Value::Null).await.0, 404);
    }
}
