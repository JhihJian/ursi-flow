//! 工作清单、包、资源定义及其持久化。
mod catalog;
mod directories;
mod environment;
mod executor;
mod mcp;

fn mcp_client_info(version: rmcp::model::ProtocolVersion) -> rmcp::model::ClientConfig {
    use rmcp::model::{ClientCapabilities, ClientConfig, Implementation};
    ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new("ursi-workbench", env!("CARGO_PKG_VERSION")),
    )
    .with_protocol_version(version)
}
mod patches;
mod store;
mod worklist;
use axum::{
    Json, Router,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::{io, path::PathBuf};
use store::Store;

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
pub(crate) fn routes(dir: PathBuf) -> io::Result<Router> {
    let store = Store::open(dir)?;
    Ok(catalog::routes(store.clone())
        .merge(worklist::routes(store.clone()))
        .merge(mcp::routes(store.clone()))
        .merge(environment::routes(store.clone()))
        .merge(executor::routes(store.clone()))
        .merge(directories::routes(store.clone())?)
        .merge(patches::routes(store)))
}
