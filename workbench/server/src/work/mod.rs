//! 工作管理与持久化。后端不会直接改变工作项的验收状态。
mod catalog;
mod echo;
mod execute;
mod items;
mod patches;
mod preparation;
mod sources;
mod store;
mod workspace_sop;
use axum::{
    Json, Router,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::{io, path::PathBuf};
use store::Store;
use ursi_flow_client::FlowClient;

#[derive(Debug)]
enum Error {
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
pub(crate) fn routes(
    dir: PathBuf,
    workspace: PathBuf,
    flow: Option<FlowClient>,
) -> io::Result<Router> {
    let store = Store::open(dir)?;
    let external = sources::routes(store.clone())?;
    Ok(catalog::routes(store.clone())
        .merge(items::routes(store.clone()))
        .merge(workspace_sop::routes(store.clone()))
        .merge(preparation::routes(store.clone()))
        .merge(patches::routes(store.clone())?)
        .merge(echo::routes(store.clone()))
        .merge(external)
        .merge(execute::routes(store, workspace, flow)))
}
