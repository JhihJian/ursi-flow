//! 静态页面资源：web/dist 构建产物的目录读取与 SPA 回退。
//!
//! SPEC「静态页面资源」：
//! - 配置 root 时读取目录（ServeDir 风格）；未配置或目录缺失时服务正常
//!   启动（不 panic），静态路由返回 404 明确响应；
//! - 页面导航路径回退 index.html（深链 /roles、/runs 由前端 Router 处理）；
//!   未知页面路径同样回退 index.html，由前端显示未找到；
//! - 路径穿越（`..`、编码变体、绝对路径、反斜杠、内嵌空字节）被拒绝，
//!   不得越过配置的资源根目录；符号链接解析后越根同样拒绝；
//! - `/api` 前缀不进入静态回退（保留 API 错误响应，本路由只挂在回退
//!   兜底位置，API 路由优先匹配）；缺失静态资源返回 404 明确响应。
//!
//! 内嵌构建产物（feature 隔离）属于交付期选择：当前以目录读取为唯一
//! 实现，feature 化内嵌在 web 构建管线接入 app 时补充，接口
//! （StaticAssets::new）保持不变。

use std::path::{Path, PathBuf};

use axum::http::header;

#[cfg(test)]
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use crate::transport::error::ApiError;

/// 静态资源服务：可选 root + SPA 回退。
#[derive(Debug, Clone)]
pub struct StaticAssets {
    /// 页面资源根目录（通常是 web/dist）。None 表示未配置。
    root: Option<PathBuf>,
    /// SPA 入口文件名。
    index_file: String,
}

impl StaticAssets {
    /// 未配置静态目录：服务正常启动，静态路由一律 404 明确响应。
    pub fn disabled() -> Self {
        StaticAssets {
            root: None,
            index_file: "index.html".to_string(),
        }
    }

    /// 配置资源根目录。目录不存在时记录日志但不 panic（服务可启动，
    /// 请求时返回明确 404）。
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        if !root.is_dir() {
            tracing::warn!("静态资源目录不存在，静态请求将返回 404：{}", root.display());
        }
        StaticAssets {
            root: Some(root),
            index_file: "index.html".to_string(),
        }
    }

    fn root(&self) -> Option<&Path> {
        let root = self.root.as_deref()?;
        root.is_dir().then_some(root)
    }

    /// 解析请求路径到物理文件。返回值：
    /// - `Ok(Some(path))`：命中的文件（SPA 回退时为 index.html）；
    /// - `Ok(None)`：资源缺失（404）；
    /// - `Err`：路径穿越等恶意请求（403 语义）。
    fn resolve(&self, request_path: &str) -> Result<Option<PathBuf>, PathReject> {
        let Some(root) = self.root() else {
            // 未配置或目录缺失：导航路径回退的 index.html 也不存在，
            // 统一视为资源缺失（由调用方转 404 明确响应）。
            return Ok(None);
        };

        let cleaned = request_path.split('?').next().unwrap_or(request_path);
        let cleaned = cleaned.split('#').next().unwrap_or(cleaned);
        let mut rel = cleaned.trim_start_matches('/');
        if rel.is_empty() {
            rel = self.index_file.as_str();
        }
        let safe = sanitize(rel).ok_or(PathReject::Traversal)?;
        let root_canon = root.canonicalize().map_err(|_| PathReject::Traversal)?;
        let full = root.join(&safe);
        let full = match full.canonicalize() {
            Ok(path) => path,
            Err(_) => {
                // 物理路径不存在：若请求形如页面导航（无扩展名且非
                // API 前缀），回退 index.html 由前端路由处理；否则视为
                // 资源缺失。
                let first_segment = safe.split('/').next().unwrap_or("");
                let is_navigation =
                    !safe.contains('.') && first_segment != "api";
                if is_navigation {
                    let index = root.join(&self.index_file);
                    if index.is_file() {
                        return Ok(Some(index));
                    }
                }
                tracing::debug!("静态资源不存在：{}", full.display());
                return Ok(None);
            }
        };
        if !full.starts_with(&root_canon) {
            return Err(PathReject::Traversal);
        }
        if full.is_file() {
            Ok(Some(full))
        } else {
            // 目录或非常规文件：SPA 导航路径回退 index.html。
            let index = root.join(&self.index_file);
            if index.is_file() { Ok(Some(index)) } else { Ok(None) }
        }
    }

    /// 处理任意页面/静态请求（挂在路由兜底位置）。
    pub async fn serve(&self, request_path: &str) -> Response {
        match self.resolve(request_path) {
            Err(PathReject::Traversal) => ApiError::forbidden("路径越出静态资源根目录").into_response(),
            Ok(Some(path)) => match read_file(&path).await {
                Ok((content_type, bytes)) => {
                    ([(header::CONTENT_TYPE, content_type)], bytes).into_response()
                }
                Err(_) => ApiError::not_found("静态资源").into_response(),
            },
            Ok(None) => ApiError::not_found("静态资源").into_response(),
        }
    }
}

enum PathReject {
    Traversal,
}

/// 路径清洗：拒绝任何可能越出根目录的形态。
/// 返回 None 表示请求不可信，直接拒绝（不回退 index.html）。
fn sanitize(rel: &str) -> Option<String> {
    if rel.contains('\0') || rel.contains('\\') {
        return None;
    }
    // 拒绝 URL 编码痕迹：`%2e`(.)、`%2f`(/)、`%5c`(\) 是常见的穿越
    // 变体，axum 兜底路由拿到的已是解码路径，原始请求中的 %xx 说明
    // 客户端在故意构造绕过形态。
    let lowered = rel.to_ascii_lowercase();
    if lowered.contains("%2e") || lowered.contains("%2f") || lowered.contains("%5c") {
        return None;
    }
    // 逐段清洗：保留目录结构，拒绝任意 ".." 段；空段与 "." 段跳过。
    let mut segments: Vec<&str> = Vec::new();
    for segment in rel.split('/') {
        match segment {
            "" | "." => {}
            ".." => return None,
            seg => segments.push(seg),
        }
    }
    if segments.is_empty() {
        return None;
    }
    // 编码痕迹（%2e 等）交由 canonicalize + 根前缀校验兜底。
    Some(segments.join("/"))
}

async fn read_file(path: &Path) -> std::io::Result<(String, Vec<u8>)> {
    let content_type = content_type_of(path);
    let bytes = std::fs::read(path)?;
    Ok((content_type, bytes))
}

/// 按扩展名给出 Content-Type。覆盖静态站常见类型，未知类型按字节流。
fn content_type_of(path: &Path) -> String {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    fn temp_dist() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("index.html"), "<html>index</html>").unwrap();
        std::fs::write(root.join("assets/app.js"), "console.log(1)").unwrap();
        std::fs::write(root.join("roles.html"), "<html>roles</html>").unwrap();
        (dir, root)
    }

    /// SPEC：未配置静态目录时返回明确 404 且不 panic。
    #[tokio::test]
    async fn disabled_returns_explicit_404() {
        let assets = StaticAssets::disabled();
        let response = assets.serve("/").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes = to_bytes(response.into_body(), 8192).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"]["code"], "not_found");
    }



    /// SPEC：目录缺失时服务不 panic、返回明确 404。
    #[tokio::test]
    async fn missing_root_returns_explicit_404() {
        let assets = StaticAssets::new("/nonexistent/ursi-dist-xyz");
        let response = assets.serve("/index.html").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    /// SPEC：可返回页面与静态资源。
    #[tokio::test]
    async fn serves_index_and_assets() {
        let (_guard, root) = temp_dist();
        let assets = StaticAssets::new(&root);
        let response = assets.serve("/").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        let bytes = to_bytes(response.into_body(), 8192).await.unwrap();
        assert_eq!(&bytes[..], b"<html>index</html>");

        let response = assets.serve("/assets/app.js").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
    }

    /// SPEC：导航路径回退 index.html，未知页面路径交由前端处理。
    #[tokio::test]
    async fn navigation_paths_fall_back_to_index() {
        let (_guard, root) = temp_dist();
        let assets = StaticAssets::new(&root);
        for path in ["/roles", "/runs", "/runs/run-1", "/unknown-page"] {
            let response = assets.serve(path).await;
            assert_eq!(response.status(), StatusCode::OK, "path={path}");
            let bytes = to_bytes(response.into_body(), 8192).await.unwrap();
            assert_eq!(&bytes[..], b"<html>index</html>", "path={path}");
        }
    }

    /// SPEC：路径穿越被拒绝，不越根。
    #[tokio::test]
    async fn traversal_is_rejected() {
        let (guard, root) = temp_dist();
        std::fs::write(guard.path().join("secret.txt"), "top-secret").unwrap();
        let assets = StaticAssets::new(&root);
        for path in [
            "/../secret.txt",
            "/../../secret.txt",
            "/assets/../../../secret.txt",
            "/..%2fsecret.txt",
            "/%2e%2e/secret.txt",
            "/..\\secret.txt",
            "/a/b/../../../../secret.txt",
        ] {
            let response = assets.serve(path).await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "path={path}");
        }
    }

    /// SPEC：/api、/api/* 及缺失静态资源保留错误响应，不回退 index.html。
    #[tokio::test]
    async fn missing_assets_do_not_fall_back() {
        let (_guard, root) = temp_dist();
        let assets = StaticAssets::new(&root);
        // API 前缀与带扩展名的缺失路径不回退 index.html（API 路由优先
        // 匹配，不会走到这里；这里校验兜底本身的防御）。
        for path in ["/api", "/api/v1/workflows", "/missing.js"] {
            let response = assets.serve(path).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "path={path}");
        }
    }


    /// sanitize：穿越、空字节、反斜杠形态一律拒绝。
    #[test]
    fn sanitize_rejects_malicious_segments() {
        assert_eq!(sanitize("assets/app.js").as_deref(), Some("assets/app.js"));
        assert_eq!(sanitize("index.html").as_deref(), Some("index.html"));
        assert_eq!(sanitize("./assets/./x.js").as_deref(), Some("assets/x.js"));
        assert_eq!(sanitize("").as_deref(), None);
        assert!(sanitize("..").is_none());
        assert!(sanitize("a/../../b").is_none());
        assert!(sanitize("a\0b").is_none());
        assert!(sanitize("a\\b").is_none());
        assert!(sanitize("..%2fsecret.txt").is_none());
        assert!(sanitize("%2e%2e/secret.txt").is_none());
        assert!(sanitize("a%5cb").is_none());
    }
}
