//! 静态页面资源验收测试（经完整 HTTP 服务）：目录读取、SPA 回退、
//! 路径穿越拒绝、未配置目录不 panic 且明确 404。
//!
//! 覆盖 SPEC transport「静态页面资源」全部验收条目（目录读取形态）。

use std::net::SocketAddr;

use axum::http::StatusCode;
use reqwest::Client;

use crate::transport::static_assets::StaticAssets;
use crate::transport::stubs::test_app_state;
use crate::transport::serve;

/// 启动服务并返回 base URL 与静态根目录句柄。
async fn spawn_app(root: StaticAssets) -> String {
    let (state, _wf, _roles, _runs, _art, _sbx, _conn, _events) = test_app_state(root);
    let addr = serve(state, SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .expect("测试服务启动成功");
    format!("http://{addr}")
}

fn temp_dist() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    std::fs::create_dir_all(root.join("assets")).unwrap();
    std::fs::write(root.join("index.html"), "<html>ursi index</html>").unwrap();
    std::fs::write(root.join("assets/app.js"), "console.log('app')").unwrap();
    (dir, root)
}

/// SPEC「静态页面资源」验收 2：
/// 无构建产物时服务仍可启动，静态资源缺失返回明确响应且不 panic。
#[tokio::test]
async fn missing_static_root_starts_and_returns_explicit_404() {
    let base = spawn_app(StaticAssets::disabled()).await;
    let client = Client::new();

    for path in ["/", "/index.html", "/roles", "/assets/app.js"] {
        let response = client
            .get(format!("{base}{path}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "path={path}");
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["error"]["code"], "not_found", "path={path}");
        assert_eq!(body["error"]["message"], "静态资源 不存在", "path={path}");
    }

    // 目录指向不存在路径同样不 panic。
    let base = spawn_app(StaticAssets::new("/nonexistent/ursi-dist")).await;
    let response = Client::new()
        .get(format!("{base}/"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// SPEC「静态页面资源」验收 1 + 4（目录读取形态）：
/// 可返回页面与静态资源；直接访问 /roles 等前端路径返回应用页面。
#[tokio::test]
async fn serves_pages_and_static_assets_with_spa_fallback() {
    let (_guard, root) = temp_dist();
    let base = spawn_app(StaticAssets::new(&root)).await;
    let client = Client::new();

    // 首页。
    let response = client.get(format!("{base}/")).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/html; charset=utf-8");
    let text = response.text().await.unwrap();
    assert_eq!(text, "<html>ursi index</html>");

    // 静态资源。
    let response = client
        .get(format!("{base}/assets/app.js"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        "text/javascript; charset=utf-8"
    );

    // 前端导航路径回退 index.html（Router 处理深链）。
    for path in ["/roles", "/runs", "/runs/run-1", "/workflows"] {
        let response = client.get(format!("{base}{path}")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "path={path}");
        let text = response.text().await.unwrap();
        assert_eq!(text, "<html>ursi index</html>", "path={path}");
    }

    // 未知页面路径同样回退 index.html，由前端显示未找到。
    let response = client
        .get(format!("{base}/unknown-page"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

/// SPEC「静态页面资源」验收 3：
/// 静态路径不能越过配置的资源根目录。
#[tokio::test]
async fn traversal_requests_rejected() {
    let (guard, root) = temp_dist();
    // 把秘密文件放在资源根目录之外（tempdir 父目录）。
    let secret = guard.path().parent().unwrap().join("secret-out.txt");
    std::fs::write(&secret, "top-secret-credential").unwrap();
    let base = spawn_app(StaticAssets::new(&root)).await;
    let client = Client::new();

    let attempts = [
        "/../secret.txt",
        "/../../secret.txt",
        "/assets/../../../secret.txt",
        "/..%2fsecret.txt",
        "/%2e%2e/secret.txt",
        "/%2e%2e%2fsecret.txt",
        "/..\\secret.txt",
        "/....//secret.txt",
        "/a/b/../../../../secret.txt",
    ];
    for path in attempts {
        let response = client.get(format!("{base}{path}")).send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        assert_ne!(status, StatusCode::OK, "path={path} 不应成功：{text}");
        assert!(
            !text.contains("top-secret-credential"),
            "path={path} 泄露根外内容：{text}"
        );
    }
}

/// SPEC「静态页面资源」验收 5：
/// /api、/api/* 及缺失静态资源保留对应错误响应，不回退 index.html。
#[tokio::test]
async fn api_paths_keep_error_responses() {
    let (_guard, root) = temp_dist();
    let base = spawn_app(StaticAssets::new(&root)).await;
    let client = Client::new();

    // API 正常路由可用（不进静态兜底）。
    let response = client
        .get(format!("{base}/api/v1/workflows"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // 缺失 API 资源保留 404 JSON 错误（不回退 index.html）。
    let response = client
        .get(format!("{base}/api/v1/workflows/missing"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "not_found");

    // 缺失静态资源同样 404（无 index.html 回退）。
    let response = client
        .get(format!("{base}/missing.js"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "not_found");
}
