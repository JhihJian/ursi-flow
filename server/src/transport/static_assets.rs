use super::error::error;
use axum::{
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use std::{
    io,
    path::{Path, PathBuf},
};

pub(super) async fn serve(root: Option<PathBuf>, path: &str) -> Response {
    let Some(root) = root else {
        return error(StatusCode::NOT_FOUND);
    };
    let path = path.to_owned();
    match tokio::task::spawn_blocking(move || read_asset(&root, &path)).await {
        Ok(Ok((mime, bytes))) => ([(header::CONTENT_TYPE, mime)], bytes).into_response(),
        Ok(Err(status)) => error(status),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

fn read_asset(root: &Path, path: &str) -> Result<(&'static str, Vec<u8>), StatusCode> {
    let relative = path.strip_prefix('/').unwrap_or(path);
    let lower = relative.to_ascii_lowercase();
    if relative.starts_with('/')
        || relative.contains(['\\', '\0'])
        || relative.split('/').any(|s| s == "..")
        || ["%2e", "%2f", "%5c", "%00"]
            .iter()
            .any(|s| lower.contains(s))
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let cleaned: PathBuf = relative
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if cleaned.starts_with("api") {
        return Err(StatusCode::NOT_FOUND);
    }
    let root = root.canonicalize().map_err(fs_status)?;
    let mut asset = confined_file(&root, &cleaned)?;
    if asset.is_none() && !cleaned.to_string_lossy().contains('.') {
        // 深链回退也校验 index.html 的最终位置。
        asset = confined_file(&root, Path::new("index.html"))?;
    }
    let file = asset.ok_or(StatusCode::NOT_FOUND)?;
    Ok((content_type(&file), std::fs::read(file).map_err(fs_status)?))
}

fn confined_file(root: &Path, relative: &Path) -> Result<Option<PathBuf>, StatusCode> {
    let path = match root.join(relative).canonicalize() {
        Ok(path) => path,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(fs_status(e)),
    };
    if !path.starts_with(root) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(path.is_file().then_some(path))
}

fn fs_status(e: io::Error) -> StatusCode {
    match e.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => StatusCode::NOT_FOUND,
        io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn content_type(path: &Path) -> &'static str {
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
}
