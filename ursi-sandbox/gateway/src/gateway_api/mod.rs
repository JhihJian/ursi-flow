//! Gateway 服务间 API。`/healthz` 匿名，其余接口要求显式配置的 Bearer key。
//! 创建和生命周期动作返回 202 + Sandbox，读取返回 200。
//! 列表、端点、日志分别返回 `{sandboxes: [...]}`、`{endpoints: [...]}`、
//! `{content: "..."}`。能力返回 `{driver, capabilities, tunnel_enabled}`。
//! 错误固定为 `{error: {code, message}}`，不向调用方输出底层错误原文。
//! Gateway key 只授权资源控制和隧道，不替代沙箱中上层服务的身份认证。

mod observations;
use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{
        Path, Query, State, WebSocketUpgrade,
        rejection::{JsonRejection, PathRejection, QueryRejection},
        ws::rejection::WebSocketUpgradeRejection,
    },
    http::{HeaderMap, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;
use ursi_catalog::{Registry, RegistryConfig};

use crate::{
    lifecycle::{Action, Service},
    models::{Error, Sandbox, SandboxSpec, valid_name},
    tunnel::{self, ConnectError},
};

#[derive(Clone)]
struct ApiState {
    service: Arc<Service>,
    api_key: Arc<str>,
    tunnel_enabled: bool,
    observer: Option<reqwest::Client>,
}

pub fn router(service: Arc<Service>, api_key: String, tunnel_enabled: bool) -> Router {
    #[cfg(not(unix))]
    let observer = None;
    #[cfg(unix)]
    let observer = std::env::var_os("URSI_GATEWAY_OBSERVER_SOCKET").and_then(|path| {
        reqwest::Client::builder()
            .no_proxy()
            .unix_socket(std::path::PathBuf::from(path))
            .redirect(reqwest::redirect::Policy::none())
            .read_timeout(std::time::Duration::from_secs(10))
            .build()
            .ok()
    });
    let state = ApiState {
        observer,
        service,
        api_key: api_key.into(),
        tunnel_enabled,
    };
    Router::new()
        .route("/api/v1/capabilities", get(capabilities))
        .route("/api/v1/registry", get(registry).put(replace_registry))
        .route("/api/v1/sandboxes", post(create).get(list))
        .route("/api/v1/sandboxes/{id}", get(get_sandbox).delete(delete))
        .route("/api/v1/sandboxes/{id}/start", post(start))
        .route("/api/v1/sandboxes/{id}/stop", post(stop))
        .route("/api/v1/sandboxes/{id}/rebuild", post(rebuild))
        .route("/api/v1/sandboxes/{id}/logs", get(logs))
        .route("/api/v1/sandboxes/{id}/endpoints", get(endpoints))
        .route("/api/v1/sandboxes/{id}/connect/{endpoint}", get(connect))
        .merge(observations::routes())
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .route("/healthz", get(health))
        .with_state(state)
}

async fn authenticate(
    State(state): State<ApiState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if state.api_key.trim().is_empty() {
        return ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "Gateway authentication is not configured",
        )
        .into_response();
    }
    if !authorized(request.headers(), &state.api_key) {
        let mut response = ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Valid Bearer authentication is required",
        )
        .into_response();
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            header::HeaderValue::from_static("Bearer"),
        );
        return response;
    }
    next.run(request).await
}

fn authorized(headers: &HeaderMap, key: &str) -> bool {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let Some(value) = values.next().and_then(|value| value.to_str().ok()) else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    let Some((scheme, token)) = value.split_once(' ') else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("bearer")
        || token.is_empty()
        || token.bytes().any(|byte| byte.is_ascii_whitespace())
    {
        return false;
    }
    // 同长度 key 比较不因第一个不同字节提前退出。
    token.len() == key.len()
        && token
            .bytes()
            .zip(key.bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({"status": "ok"}))
}

async fn capabilities(State(state): State<ApiState>) -> Json<serde_json::Value> {
    Json(json!({
        "driver": state.service.driver_name(),
        "capabilities": state.service.capabilities(),
        "tunnel_enabled": state.tunnel_enabled,
        "observer_enabled": state.observer.is_some() && state.service.driver_name() == "docker",
    }))
}

async fn registry(State(state): State<ApiState>) -> Json<Registry> {
    Json(state.service.registry())
}

async fn replace_registry(
    State(state): State<ApiState>,
    body: Result<Json<RegistryConfig>, JsonRejection>,
) -> Result<Json<Registry>, ApiError> {
    let Json(config) = body.map_err(|_| ApiError::invalid("Invalid registry JSON"))?;
    let registry =
        Registry::new(config).map_err(|_| ApiError::invalid("Registry validation failed"))?;
    state.service.replace_registry(registry.clone())?;
    Ok(Json(registry))
}

async fn create(
    State(state): State<ApiState>,
    headers: HeaderMap,
    body: Result<Json<SandboxSpec>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(spec) = body.map_err(|_| ApiError::invalid("Invalid sandbox JSON"))?;
    if spec.bundle.is_some() {
        return Err(ApiError::invalid("bundle 只能由管理员注册表决定"));
    }
    // Lifecycle binds the registry runtime before validating the combined spec.
    let mut keys = headers.get_all("idempotency-key").iter();
    let key = keys
        .next()
        .map(|value| {
            let value = value
                .to_str()
                .map_err(|_| ApiError::invalid("Invalid Idempotency-Key"))?;
            if value.trim().is_empty() || value.len() > 256 || keys.next().is_some() {
                return Err(ApiError::invalid("Invalid Idempotency-Key"));
            }
            Ok(value.to_owned())
        })
        .transpose()?;
    Ok((
        StatusCode::ACCEPTED,
        Json(public_sandbox(state.service.create(spec, key).await?)),
    )
        .into_response())
}

async fn list(State(state): State<ApiState>) -> Result<Json<serde_json::Value>, ApiError> {
    let sandboxes: Vec<_> = state
        .service
        .list()?
        .into_iter()
        .map(public_sandbox)
        .collect();
    Ok(Json(json!({"sandboxes": sandboxes})))
}

type IdPath = Result<Path<String>, PathRejection>;
fn sandbox_id(path: IdPath) -> Result<String, ApiError> {
    let Path(id) = path.map_err(|_| ApiError::invalid("Invalid sandbox identifier"))?;
    if !valid_name(&id) {
        return Err(ApiError::invalid("Invalid sandbox identifier"));
    }
    Ok(id)
}

async fn get_sandbox(
    State(state): State<ApiState>,
    path: IdPath,
) -> Result<Json<Sandbox>, ApiError> {
    Ok(Json(public_sandbox(state.service.get(&sandbox_id(path)?)?)))
}

async fn action(state: ApiState, path: IdPath, action: Action) -> Result<Response, ApiError> {
    let id = sandbox_id(path)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(public_sandbox(state.service.request(&id, action).await?)),
    )
        .into_response())
}
async fn start(State(state): State<ApiState>, path: IdPath) -> Result<Response, ApiError> {
    action(state, path, Action::Start).await
}
async fn stop(State(state): State<ApiState>, path: IdPath) -> Result<Response, ApiError> {
    action(state, path, Action::Stop).await
}
async fn delete(State(state): State<ApiState>, path: IdPath) -> Result<Response, ApiError> {
    action(state, path, Action::Delete).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rebuild {
    preserve_data: bool,
}

async fn rebuild(
    State(state): State<ApiState>,
    path: IdPath,
    body: Result<Json<Rebuild>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(body) =
        body.map_err(|_| ApiError::invalid("Rebuild requires preserve_data boolean"))?;
    action(
        state,
        path,
        Action::Rebuild {
            preserve_data: body.preserve_data,
        },
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LogsQuery {
    #[serde(default = "default_tail")]
    tail: usize,
}
fn default_tail() -> usize {
    5000
}

async fn logs(
    State(state): State<ApiState>,
    path: IdPath,
    query: Result<Query<LogsQuery>, QueryRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Query(query) = query.map_err(|_| ApiError::invalid("Invalid log query"))?;
    let content = state.service.logs(&sandbox_id(path)?, query.tail).await?;
    Ok(Json(json!({"content": content})))
}

async fn endpoints(
    State(state): State<ApiState>,
    path: IdPath,
) -> Result<Json<serde_json::Value>, ApiError> {
    let sandbox = state.service.get(&sandbox_id(path)?)?;
    Ok(Json(json!({"endpoints": sandbox.endpoints})))
}

async fn connect(
    State(state): State<ApiState>,
    path: Result<Path<(String, String)>, PathRejection>,
    uri: Uri,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Result<Response, ApiError> {
    if !state.tunnel_enabled {
        return Err(Error::Unsupported("tunnel disabled".into()).into());
    }
    validate_connect(&uri, &headers)?;
    let Path((id, endpoint)) = path.map_err(|_| ApiError::invalid("Invalid tunnel identifiers"))?;
    let upgrade = upgrade.map_err(|_| ApiError::invalid("Invalid WebSocket upgrade"))?;
    let mut generations = headers.get_all("x-ursi-generation").iter();
    let generation = generations
        .next()
        .map(|header| {
            header
                .to_str()
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|n| *n > 0)
                .ok_or_else(|| ApiError::invalid("Invalid X-Ursi-Generation"))
        })
        .transpose()?;
    if generations.next().is_some() {
        return Err(ApiError::invalid("Duplicate X-Ursi-Generation"));
    }
    let target = tunnel::connect(&state.service, &id, &endpoint, generation)
        .await
        .map_err(|error| match error {
            ConnectError::Service(error) => ApiError::from(error),
            ConnectError::Unreachable => ApiError::new(
                StatusCode::BAD_GATEWAY,
                "bad_gateway",
                "Sandbox endpoint is unreachable",
            ),
        })?;
    Ok(tunnel::configure(upgrade)
        .on_upgrade(move |socket| tunnel::relay(socket, target, state.service, id)))
}

fn validate_connect(uri: &Uri, headers: &HeaderMap) -> Result<(), ApiError> {
    if uri.query().is_some() || headers.contains_key(header::ORIGIN) {
        return Err(ApiError::invalid(
            "Tunnel requires a server-to-server request without Origin or query",
        ));
    }
    let protocol = headers
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .any(|header| {
            header.to_str().is_ok_and(|value| {
                value
                    .split(',')
                    .any(|protocol| protocol.trim() == tunnel::PROTOCOL)
            })
        });
    if !protocol {
        return Err(ApiError::invalid("ursi-tcp-v1 subprotocol is required"));
    }
    Ok(())
}

/// 持久化错误可以含驱动命令、地址或凭据，HTTP DTO 仅保留安全状态提示。
fn public_sandbox(mut sandbox: Sandbox) -> Sandbox {
    // Runtime 下载地址和摘要是管理员配置，不属于公共控制面 DTO。
    sandbox.spec.bundle = None;
    if sandbox.error.is_some() {
        sandbox.error = Some("Sandbox operation failed".into());
    }
    sandbox
}

struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}
impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }
    fn invalid(message: &'static str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid", message)
    }
}
impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        match error {
            Error::Invalid(_) => Self::invalid("Invalid request"),
            Error::NotFound(_) => Self::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "Sandbox or endpoint was not found",
            ),
            Error::Conflict(_) => Self::new(
                StatusCode::CONFLICT,
                "conflict",
                "Sandbox state conflicts with this operation",
            ),
            Error::Unsupported(_) => Self::new(
                StatusCode::NOT_IMPLEMENTED,
                "unsupported",
                "Operation is not supported",
            ),
            Error::Unavailable(_) => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "Sandbox service is unavailable",
            ),
            Error::Internal(_) => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Internal gateway error",
            ),
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error": {"code": self.code, "message": self.message}})),
        )
            .into_response()
    }
}
async fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "Route was not found")
}
async fn method_not_allowed() -> ApiError {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "method_not_allowed",
        "Method is not allowed",
    )
}

#[cfg(test)]
mod tests;
