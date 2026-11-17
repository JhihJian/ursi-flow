//! MCP 接入：装配 ursi-mcp-server::McpServer，暴露 HTTP 调用入口。
//!
//! POST /api/v1/mcp/invoke，请求体 `{"name": "...", "args": {...}}`。
//! 运行与节点身份来自可信调用上下文（`x-run-id` / `x-node-id` 请求头，
//! 由平台侧注入，工具参数不可覆盖），映射为 mcp-server 的
//! [`InvocationContext`]。请求体不提供身份字段。
//!
//! ## 错误映射（与等价 HTTP 调用同一业务校验语义）
//!
//! - 工具不存在 -> 404（同 HTTP 资源不存在语义）；
//! - 内部域调用缺 x-run-id -> 400 / missing_context（同 HTTP 上下文缺失）；
//! - args 携带 run_id / node_id 等身份键 -> 400（mcp-server 的
//!   ForbiddenIdentityArgs 校验透传，agent 无法用工具参数覆盖可信上下文）;
//! - 越权访问（CrossRunAccess）-> 403 / forbidden（同 HTTP 业务校验）；
//! - 参数无效 -> 400；
//! - 后端执行失败（Execution）属于基础设施故障，统一 500 脱敏，不透出
//!   内部错误详情；NotFound / CrossRun 语义已由 backend 在后端侧区分并
//!   转为对应工具错误。
//!
//! 成功响应：`{"result": <ToolOutput JSON>}`。

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::Value;
use ursi_mcp_server::{Domain, DomainId, InvocationContext, McpServer, ToolError};

use crate::transport::error::ApiError;
use crate::transport::AppState;

/// MCP invoke 请求体。没有身份字段：身份只来自可信头。
#[derive(Debug, Deserialize)]
pub struct McpInvokeRequest {
    pub name: String,
    #[serde(default)]
    pub args: Value,
}

/// 装配 MCP server：按域注入 backend（app 装配真实业务适配器，测试注入替身）。
/// 未注册的域对调用方完全不可见（mcp-server SPEC 验收）。
pub fn assemble_mcp_server(domains: &[Domain]) -> Result<Arc<McpServer>, ApiError> {
    McpServer::register_domain(domains)
        .map(Arc::new)
        .map_err(|err| {
            tracing::error!("MCP 域装配失败：{err}");
            ApiError::Internal
        })
}

/// POST /api/v1/mcp/invoke。
pub async fn invoke_tool(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<McpInvokeRequest>,
) -> Response {
    // 可信上下文：来自请求头（平台侧注入），不来自工具参数。
    let run_id = header_value(&headers, "x-run-id");
    let node_id = header_value(&headers, "x-node-id");

    let ctx = if run_id.is_empty() {
        // 运维域/控制域工具不消费身份，允许 detached 调用；内部域工具
        // 在 mcp-server 侧报 MissingInvocationContext。
        InvocationContext::detached()
    } else {
        InvocationContext::new(run_id, node_id, "")
    };

    match state.mcp.invoke(&body.name, Some(&ctx), body.args).await {
        Ok(output) => (StatusCode::OK, Json(serde_json::json!({ "result": output }))).into_response(),
        Err(err) => map_tool_error(err).into_response(),
    }
}

fn header_value(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

/// ToolError -> HTTP 错误。语义对齐等价 HTTP 调用：
/// 不存在 404、越权 403、参数/上下文 400、其余内部故障 500 脱敏。
pub(crate) fn map_tool_error(err: ToolError) -> ApiError {
    match err {
        ToolError::UnknownTool { .. } => ApiError::not_found("工具"),
        ToolError::MissingInvocationContext => ApiError::MissingContext,
        ToolError::MissingNodeIdentity => ApiError::bad_request("上下文缺少节点身份，无法定位节点资源"),
        ToolError::ForbiddenIdentityArgs { keys } => ApiError::bad_request(format!(
            "工具参数禁止携带运行身份字段：{}（身份只来自可信调用上下文）",
            keys.join(", ")
        )),
        ToolError::CrossRunAccess { resource, owner_run, context_run } => ApiError::forbidden(format!(
            "资源 {resource} 属于运行 {owner_run}，当前上下文运行 {context_run}"
        )),
        ToolError::InvalidArgs { .. } => ApiError::bad_request("工具参数无效"),
        // 后端执行失败：可能是业务 NotFound，也可能基础设施故障。消息
        // 可能含内部细节，统一脱敏为 500，不透出 message。
        ToolError::Execution { .. } => {
            tracing::warn!("MCP 工具执行失败（已脱敏返回）：{err}");
            ApiError::Internal
        }
    }
}

/// 暴露的工具清单（调试/发现用途，非 SPEC 必需，供联调核对）。
pub fn list_tools(server: &McpServer, domain: Option<DomainId>) -> Vec<ursi_mcp_server::ToolDescriptor> {
    server.list_tools(domain)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 错误映射与等价 HTTP 语义一致。
    #[test]
    fn tool_error_maps_to_http_semantics() {
        use ursi_mcp_server::ToolError;
        assert_eq!(
            map_tool_error(ToolError::UnknownTool { name: "x".into() }).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            map_tool_error(ToolError::MissingInvocationContext).status(),
            StatusCode::BAD_REQUEST
        );
        let forbidden = map_tool_error(ToolError::CrossRunAccess {
            resource: "art-1".into(),
            owner_run: "run-1".into(),
            context_run: "run-2".into(),
        });
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        assert_eq!(forbidden.code(), "forbidden");
        // 内部故障脱敏：不透出内部消息。
        let internal = map_tool_error(ToolError::Execution {
            tool: "internal_get_run_status".into(),
            message: "sqlite lock: secret-detail".into(),
        });
        assert_eq!(internal, ApiError::Internal);
    }

    /// 请求体解析：缺 name 直接失败（handler 返回 400，不触发调用）。
    #[test]
    fn invoke_request_requires_name() {
        let parsed: Result<McpInvokeRequest, _> = serde_json::from_value(serde_json::json!({"args": {}}));
        assert!(parsed.is_err());
        let parsed: McpInvokeRequest =
            serde_json::from_value(serde_json::json!({"name": "ops_gateway_status"})).unwrap();
        assert_eq!(parsed.name, "ops_gateway_status");
    }
}
