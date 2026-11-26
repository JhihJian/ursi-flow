use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

pub(super) fn error(status: StatusCode) -> Response {
    let code = match status {
        StatusCode::UNAUTHORIZED => "unauthorized",
        StatusCode::FORBIDDEN => "forbidden",
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::BAD_REQUEST => "invalid_request",
        StatusCode::CONFLICT => "conflict",
        StatusCode::TOO_MANY_REQUESTS => "runtime_busy",
        StatusCode::BAD_GATEWAY => "runtime_protocol_error",
        StatusCode::SERVICE_UNAVAILABLE => "runtime_unavailable",
        StatusCode::GATEWAY_TIMEOUT => "runtime_timeout",
        _ => "internal_error",
    };
    (
        status,
        Json(json!({"error": {"code":code,"message":status.canonical_reason()}})),
    )
        .into_response()
}
