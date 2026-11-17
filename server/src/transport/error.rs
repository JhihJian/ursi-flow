//! API 错误契约与 HTTP 错误映射。
//!
//! 统一错误响应体为 `{"error":{"code":"...","message":"..."}}`：
//! - 400：请求无法解析、缺少必填字段、事件游标非法、缺少可信调用上下文；
//! - 403：越权访问（资源归属与上下文运行不一致）；
//! - 404：资源不存在、工具不存在、静态资源缺失；
//! - 409：引用或状态冲突；
//! - 500：基础设施或内部故障，消息固定脱敏，不透出内部错误详情字符串。
//!
//! 业务域注入接口（[`crate::transport::ports`]）以本类型作为错误类型，
//! 各业务域的真实实现把本域错误映射为这里的语义，transport 不再自行
//! 解释业务错误文本。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

/// transport 层统一错误：HTTP 状态、稳定错误码与脱敏消息。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApiError {
    /// 请求体无法解析或缺必填字段；此时业务服务不会被调用。
    /// 400 / invalid_request。
    #[error("{message}")]
    BadRequest {
        message: String,
    },
    /// 事件游标非法（非非负整数或超出范围）。400 / invalid_cursor。
    #[error("事件游标无效：{message}")]
    InvalidCursor {
        message: String,
    },
    /// 内部域 MCP 工具调用缺少可信调用上下文（x-run-id / x-node-id）。
    /// 400 / missing_context。
    #[error("缺少可信调用上下文（x-run-id / x-node-id）")]
    MissingContext,
    /// 资源不存在。404 / not_found。
    #[error("{resource} 不存在")]
    NotFound {
        resource: String,
    },
    /// 资源归属与调用上下文不一致（越权访问）。403 / forbidden。
    #[error("{message}")]
    Forbidden {
        message: String,
    },
    /// 引用或状态冲突。409 / conflict。
    #[error("{message}")]
    Conflict {
        message: String,
    },
    /// 基础设施或内部故障。消息固定，不透出内部错误详情。500 / internal_error。
    #[error("服务内部错误")]
    Internal,
}

impl ApiError {
    /// 稳定错误码，响应体 `error.code` 字段。
    pub fn code(&self) -> &'static str {
        match self {
            ApiError::BadRequest { .. } => "invalid_request",
            ApiError::InvalidCursor { .. } => "invalid_cursor",
            ApiError::MissingContext => "missing_context",
            ApiError::NotFound { .. } => "not_found",
            ApiError::Forbidden { .. } => "forbidden",
            ApiError::Conflict { .. } => "conflict",
            ApiError::Internal => "internal_error",
        }
    }

    /// 脱敏后的错误消息：Internal 返回固定文案，不透出内部详情。
    /// NotFound 返回 "{resource} 不存在" 完整句子。
    pub fn message(&self) -> String {
        match self {
            ApiError::BadRequest { message } => message.clone(),
            ApiError::InvalidCursor { message } => message.clone(),
            ApiError::MissingContext => "缺少可信调用上下文（x-run-id / x-node-id）".to_string(),
            ApiError::NotFound { resource } => format!("{resource} 不存在"),
            ApiError::Forbidden { message } => message.clone(),
            ApiError::Conflict { message } => message.clone(),
            ApiError::Internal => "服务内部错误".to_string(),
        }
    }

    /// 对应 HTTP 状态码。
    pub fn status(&self) -> StatusCode {
        match self {
            ApiError::BadRequest { .. }
            | ApiError::InvalidCursor { .. }
            | ApiError::MissingContext => StatusCode::BAD_REQUEST,
            ApiError::Forbidden { .. } => StatusCode::FORBIDDEN,
            ApiError::NotFound { .. } => StatusCode::NOT_FOUND,
            ApiError::Conflict { .. } => StatusCode::CONFLICT,
            ApiError::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        ApiError::BadRequest {
            message: message.into(),
        }
    }

    pub fn not_found(resource: impl Into<String>) -> Self {
        ApiError::NotFound {
            resource: resource.into(),
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        ApiError::Conflict {
            message: message.into(),
        }
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        ApiError::Forbidden {
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = serde_json::json!({
            "error": { "code": self.code(), "message": self.message() }
        });
        (self.status(), Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    /// SPEC「业务接口与错误映射」：内部故障返回脱敏错误。
    /// Internal 变体不携带任何消息字段，响应体只有固定脱敏文案。
    #[tokio::test]
    async fn internal_error_body_is_sanitized() {
        let response = ApiError::Internal.into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"]["code"], "internal_error");
        assert_eq!(json["error"]["message"], "服务内部错误");
    }

    /// 错误响应体结构统一为 {"error":{"code","message"}}。
    #[tokio::test]
    async fn error_body_shape_is_uniform() {
        let response = ApiError::not_found("流程 wf-1").into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"]["code"], "not_found");
        assert_eq!(json["error"]["message"], "流程 wf-1 不存在");
        assert!(json.get("data").is_none());

        // 各错误变体响应体结构统一：只有 error.code / error.message。
        let cases = [
            ApiError::bad_request("参数"),
            ApiError::InvalidCursor { message: "游标".into() },
            ApiError::MissingContext,
            ApiError::not_found("流程"),
            ApiError::forbidden("越权"),
            ApiError::conflict("冲突"),
            ApiError::Internal,
        ];
        for err in cases {
            let response = err.into_response();
            let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
            let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            let obj = json.as_object().unwrap();
            assert_eq!(obj.len(), 1, "顶层只有 error 键");
            let inner = obj.get("error").and_then(|e| e.as_object()).unwrap();
            assert_eq!(inner.len(), 2);
            assert!(inner.contains_key("code") && inner.contains_key("message"));
        }
    }
}
