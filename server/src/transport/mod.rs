//! transport：HTTP、SSE、MCP 与静态页面接入。
//!
//! 职责：协议解析、路由、身份上下文、错误映射和流传输；业务操作全部
//! 经 [`ports`] 注入接口调用各业务域公开服务（DESIGN「依赖方向与公开
//! 边界」），业务状态转换与 SQL 查询由业务域拥有。
//!
//! 相对原骨架的变化：原 `serve(engine, store)` 占位与单变体
//! `ApiError::NotImplemented` 重构为完整实现——
//! - [`build_router`]：装配业务 API + SSE + 静态兜底路由；
//! - [`serve`]：绑定监听并启动 axum 服务；
//! - [`error::ApiError`]：统一错误映射（400/403/404/409/500）。
//!
//! 监听地址与端口由调用方决定（产品部署由 app 装配传 0.0.0.0，测试传
//! 127.0.0.1:0 取实际端口）。

pub mod error;
pub mod http;
pub mod mcp;
pub mod ports;
pub mod sse;
pub mod static_assets;

/// 测试替身：内存业务接口实现（仅测试编译）。
#[cfg(test)]
pub(crate) mod stubs;

/// 验收测试：进程内 HTTP 服务 + 业务接口替身。
#[cfg(test)]
mod tests {
    pub mod http_tests;
    pub mod mcp_tests;
    pub mod sse_tests;
    pub mod static_tests;
}

use std::net::SocketAddr;
use std::sync::Arc;

use axum::http::Uri;
use axum::Router;
use crate::mcp::McpServer;

pub use error::ApiError;
pub use ports::{
    ArtifactDto, ArtifactsApi, ConnectionDto, ConnectionsApi, CreateRunRequest, EventFeed,
    EventFrame, EventStream, NumberedEvent, NodeRunDto, PrepareSandboxRequest, RoleDto,
    RoleMcpServerDto, RoleSkillDto, RolesApi, RunDto, RunsApi, SandboxDto, SandboxesApi,
    WorkflowApi,
};
pub use static_assets::StaticAssets;

/// 应用状态：全部业务接口 + MCP server + 静态资源。
///
/// app 装配时注入各域真实实现；测试注入本模块替身。
#[derive(Clone)]
pub struct AppState {
    pub workflows: Arc<dyn WorkflowApi>,
    pub roles: Arc<dyn RolesApi>,
    pub runs: Arc<dyn RunsApi>,
    pub artifacts: Arc<dyn ArtifactsApi>,
    pub sandboxes: Arc<dyn SandboxesApi>,
    pub connections: Arc<dyn ConnectionsApi>,
    pub events: Arc<dyn EventFeed>,
    pub mcp: Arc<McpServer>,
    pub static_assets: Arc<StaticAssets>,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("static_assets", &self.static_assets)
            .finish_non_exhaustive()
    }
}

/// 装配完整路由：业务 API（含 SSE 与 MCP）优先，静态资源兜底。
pub fn build_router(state: AppState) -> Router {
    // SSE 单独构建为同状态路由再合入，避免状态类型推断分歧。
    let events: Router<AppState> = Router::new()
        .route("/api/v1/runs/{id}/events", axum::routing::get(sse::run_events))
        .with_state(state.clone());
    let business: Router<AppState> = http::business_router(state.clone());
    let router = business.merge(events);
    // 页面与静态资源兜底：API 路由优先匹配，未命中 API 的路径进入静态
    // 解析（/api/* 保留 JSON 错误，不回退 index.html）。with_state 内化
    // 状态后再挂兜底；静态资源句柄经 layer 注入 Extension，兜底处理器
    // 从请求扩展读取（避免 OnceLock 全局态在并行测试间串扰）。
    router
        .with_state(state.clone())
        .fallback(fallback_handler)
        .layer(axum::Extension(Arc::clone(&state.static_assets)))
}

/// 页面兜底：提取原始路径交给 [`StaticAssets`]（解析失败 / 资源缺失
/// 统一转 ApiError 响应）。
async fn fallback_handler(
    axum::Extension(assets): axum::Extension<Arc<StaticAssets>>,
    uri: Uri,
) -> axum::response::Response {
    assets.serve(uri.path()).await
}

/// 绑定监听并启动 HTTP 服务。返回实际监听地址（动态端口场景由调用方
/// 从返回值读取）。
pub async fn serve(state: AppState, addr: SocketAddr) -> Result<SocketAddr, ApiError> {
    let router = build_router(state);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|_| ApiError::Internal)?;
    let local = listener.local_addr().map_err(|_| ApiError::Internal)?;
    tracing::info!("HTTP 服务监听 {local}");
    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, router).await {
            tracing::error!("HTTP 服务退出：{err}");
        }
    });
    Ok(local)
}

