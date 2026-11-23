//! 平台 API，以及 Workbench 复用的存储和目录实现。
mod access;
mod agent_backends;
mod catalog;
pub mod directories;
mod executor;
mod patches;
mod store;

pub use access::Tokens;
use axum::{
    Json, Router,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::{io, path::PathBuf};
pub use store::Store;

#[doc(hidden)]
pub async fn acp_worker(
    root: &std::path::Path,
    id: &str,
    bin: &std::path::Path,
    policy: &std::path::Path,
) -> io::Result<()> {
    executor::work(root, id, bin, policy).await
}

#[derive(Debug)]
pub enum Error {
    Invalid(String),
    NotFound(String),
    Conflict(String),
    Unavailable(String),
    Internal(String),
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (code, message) = match self {
            Self::Invalid(s) => (StatusCode::BAD_REQUEST, s),
            Self::NotFound(s) => (StatusCode::NOT_FOUND, s),
            Self::Conflict(s) => (StatusCode::CONFLICT, s),
            Self::Unavailable(s) => (StatusCode::SERVICE_UNAVAILABLE, s),
            Self::Internal(s) => {
                eprintln!("工作存储：{s}");
                (StatusCode::INTERNAL_SERVER_ERROR, "工作存储不可用".into())
            }
        };
        (code, Json(json!({"error":message}))).into_response()
    }
}

/// All platform management and execution routes share this authorization boundary.
pub fn application(dir: PathBuf, tokens: Tokens) -> io::Result<Router> {
    let store = Store::open_platform(dir)?;
    let agents = agent_backends::Registry::from_env()?;
    let api = catalog::routes(store.clone(), agents.clone())
        .merge(agents.routes(store.clone()))
        .merge(executor::routes(store.clone(), agents))
        .merge(patches::routes(store.clone()))
        .merge(directories::routes(store.clone())?);
    Ok(access::secured(api, store, tokens))
}
