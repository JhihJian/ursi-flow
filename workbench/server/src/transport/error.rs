use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::io::{self, ErrorKind};

pub(super) type Reply = Result<Json<Value>, ApiError>;
pub(super) struct ApiError(StatusCode);

impl From<io::Error> for ApiError {
    fn from(err: io::Error) -> Self {
        let status = match err.kind() {
            ErrorKind::InvalidInput => StatusCode::BAD_REQUEST,
            ErrorKind::NotFound => StatusCode::NOT_FOUND,
            ErrorKind::AlreadyExists => StatusCode::CONFLICT,
            ErrorKind::WouldBlock => StatusCode::TOO_MANY_REQUESTS,
            ErrorKind::InvalidData | ErrorKind::UnexpectedEof => StatusCode::BAD_GATEWAY,
            ErrorKind::TimedOut => StatusCode::GATEWAY_TIMEOUT,
            ErrorKind::ConnectionRefused
            | ErrorKind::ConnectionReset
            | ErrorKind::ConnectionAborted
            | ErrorKind::NotConnected
            | ErrorKind::BrokenPipe => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self(status)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        error(self.0)
    }
}

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
