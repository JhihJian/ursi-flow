use super::*;
use axum::{
    body::{Body, Bytes, to_bytes},
    http::Request,
};
use std::{fs, path::PathBuf};
use tower::ServiceExt;

const CONFIG: &str = "/v2/patches/config";

struct App {
    router: Router,
    home: PathBuf,
}

impl App {
    fn new() -> Self {
        let home = std::env::temp_dir().join(Uuid::new_v4().to_string());
        let store = Store::open_platform(home.clone()).unwrap();
        let router = directories::routes(store.clone())
            .unwrap()
            .merge(routes(store));
        Self { router, home }
    }

    async fn request(&self, method: &str, path: &str, body: &str, status: u16) -> Bytes {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status().as_u16(), status, "{method} {path}");
        to_bytes(response.into_body(), 8192).await.unwrap()
    }

    async fn json(&self, method: &str, path: &str, body: &str) -> Value {
        serde_json::from_slice(&self.request(method, path, body, 200).await).unwrap()
    }
}

impl Drop for App {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.home);
    }
}

#[tokio::test]
async fn config_metadata_has_no_work_owner_or_nested_package() {
    let app = App::new();
    assert_eq!(app.json("GET", CONFIG, "").await, json!([]));
    let patch = app.json("POST", CONFIG, r#"{"name":"  审核助手  "}"#).await;
    let id = patch["id"].as_str().unwrap();
    let dir = patch["directoryId"].as_str().unwrap();
    assert_ne!(id, dir);
    assert_eq!(patch, json!({"id":id,"name":"审核助手","directoryId":dir}));
    assert_eq!(app.json("GET", &format!("{CONFIG}/{id}"), "").await, patch);
    app.request("GET", &format!("{CONFIG}/{dir}"), "", 404)
        .await;
    app.request("GET", &format!("/v2/directories/{id}"), "", 404)
        .await;
    for body in [
        json!({"name":"nested","configPackage":{"id":id}}),
        json!({"name":"owned","workItemId":"work-item"}),
        json!({"name":" "}),
        json!({"name":"x".repeat(81)}),
    ] {
        app.request("POST", CONFIG, &body.to_string(), 400).await;
    }
    assert_eq!(app.json("GET", CONFIG, "").await, json!([patch]));
    assert_eq!(
        app.json("GET", "/v2/directories", "").await,
        json!([{"id":dir}])
    );
}

#[tokio::test]
async fn seeds_config_anchors_and_guards_them_through_directory_routes() {
    let app = App::new();
    let patch = app.json("POST", CONFIG, r#"{"name":"配置包"}"#).await;
    let base = format!("/v2/directories/{}", patch["directoryId"].as_str().unwrap());
    let file = |path: &str| format!("{base}/file?path={path}");
    let tree = app.json("GET", &format!("{base}/tree"), "").await;
    assert_eq!(
        tree,
        json!([
            {"path":"AGENTS.md","kind":"file","size":0},
            {"path":"mcp.json","kind":"file","size":17},
            {"path":"skills","kind":"dir"}
        ])
    );
    let prompt = file("AGENTS.md");
    assert!(app.request("GET", &prompt, "", 200).await.is_empty());
    app.request("PUT", &prompt, "# hola", 409).await;
    app.request("PUT", &format!("{prompt}&replace=true"), "# hola", 204)
        .await;
    assert_eq!(
        app.request("GET", &prompt, "", 200).await.as_ref(),
        b"# hola"
    );

    let mcp = file("mcp.json");
    for invalid in ["not json", "[1]"] {
        app.request("PUT", &format!("{mcp}&replace=true"), invalid, 400)
            .await;
        assert_eq!(
            app.request("GET", &mcp, "", 200).await.as_ref(),
            br#"{"mcpServers":{}}"#
        );
    }
    let body = r#"{"mcpServers":{"tools":{"command":"x"}}}"#;
    app.request("PUT", &format!("{mcp}&replace=true"), body, 204)
        .await;
    assert_eq!(
        app.request("GET", &mcp, "", 200).await.as_ref(),
        body.as_bytes()
    );

    app.request(
        "POST",
        &format!("{base}/dir"),
        r#"{"path":"skills/review"}"#,
        204,
    )
    .await;
    app.request("PUT", &file("skills/review/SKILL.md"), "# r", 204)
        .await;
    let relocate = format!("{base}/move");
    for anchor in ["AGENTS.md", "skills", "mcp.json"] {
        app.request(
            "POST",
            &relocate,
            &json!({"from":anchor,"to":"moved"}).to_string(),
            409,
        )
        .await;
        app.request("DELETE", &format!("{base}/entry?path={anchor}"), "", 409)
            .await;
    }
    for (from, to, status) in [
        ("AGENTS.md", "skills/AGENTS.md", 409),
        ("skills/review", "prompt", 204),
        ("prompt/SKILL.md", "mcp.json", 409),
    ] {
        app.request(
            "POST",
            &relocate,
            &json!({"from":from,"to":to}).to_string(),
            status,
        )
        .await;
    }
}
