//! HTTP API 层：按 REST 资源组织的 axum 0.8 路由与处理器。
//!
//! 资源分组（状态码约定见 SPEC「业务接口与错误映射」）：
//! - `/api/v1/workflows`：CRUD；
//! - `/api/v1/roles`：CRUD（响应不含凭据字段，DTO 层排除）；
//! - `/api/v1/runs`：create / list / get / start / approve / reject / cancel，
//!   `/api/v1/runs/{id}/events` 由 [`super::sse`] 提供；
//! - `/api/v1/artifacts`：get / list（?runId=）；
//! - `/api/v1/sandboxes`：prepare / get / list（?runId=）/ release；
//! - `/api/v1/connections`：CRUD（响应只有凭据引用）；
//! - `/api/v1/mcp/invoke`：MCP 工具调用入口（见 [`super::mcp`])。
//!
//! 处理器只做协议解析：JSON 解析失败或缺必填字段直接 400，业务接口
//! 不被调用。业务语义（NotFound / Conflict / Forbidden / Internal）全部
//! 来自业务接口返回的 [`ApiError`]，handler 原样转成响应。

use axum::extract::{Path, Query, State};
use axum::extract::rejection::JsonRejection;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;


use crate::transport::error::ApiError;
use crate::transport::ports::{ArtifactDto, ApprovalRequest, ConnectionDto, CreateRunRequest, PrepareSandboxRequest, RoleDto};
use crate::transport::AppState;

/// 列表响应统一包络：`{"items": [...]}`。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Items<T> {
    items: Vec<T>,
}

/// JSON 请求体提取器：把 axum 默认 rejection（语法错误 400、数据错误
/// 422）统一映射为 400 + `{"error":{"code","message"}}`，保证错误
/// 体结构一致（SPEC「业务接口与错误映射」）。
pub struct ApiJson<T>(pub T);

impl<S, T> axum::extract::FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: serde::de::DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(req: axum::extract::Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(ApiJson(value)),
            Err(rejection) => Err(rejection_message(rejection)),
        }
    }
}

fn rejection_message(rejection: JsonRejection) -> ApiError {
    // MissingJsonContentType 与语法/数据错误统一 400，消息区分媒体类型。
    let message = if rejection.status() == StatusCode::UNSUPPORTED_MEDIA_TYPE {
        "请求需为 application/json".to_string()
    } else {
        // JsonDataError / JsonSyntaxError：给出脱敏的字段错误描述。
        let text = rejection.body_text();
        let text = text.split(": ").last().unwrap_or(text.as_str());
        format!("请求体 JSON 无效：{text}")
    };
    ApiError::bad_request(message)
}

// ---------------------------------------------------------------------------
// workflows
// ---------------------------------------------------------------------------

async fn create_workflow(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<WorkflowDefinitionBody>,
) -> Result<(StatusCode, Json<ursi_domain::WorkflowDefinition>), ApiError> {
    state.workflows.create_workflow(body.0).await.map(|wf| (StatusCode::CREATED, Json(wf)))
}

/// 请求体直接反序列化为 domain `WorkflowDefinition`（#[serde(flatten)]
/// 不能用于 newtype 结构，改用透明包装）。
#[derive(Debug, serde::Deserialize)]
#[serde(transparent)]
struct WorkflowDefinitionBody(ursi_domain::WorkflowDefinition);

async fn list_workflows(State(state): State<AppState>) -> Result<Json<Items<ursi_domain::WorkflowDefinition>>, ApiError> {
    state.workflows.list_workflows().await.map(|items| Json(Items { items }))
}

async fn get_workflow(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ursi_domain::WorkflowDefinition>, ApiError> {
    state.workflows.get_workflow(&id).await.map(Json)
}

async fn update_workflow(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<WorkflowDefinitionBody>,
) -> Result<Json<ursi_domain::WorkflowDefinition>, ApiError> {
    state.workflows.update_workflow(&id, body.0).await.map(Json)
}

async fn delete_workflow(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.workflows.delete_workflow(&id).await.map(|()| StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

async fn create_role(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<RoleDto>,
) -> Result<(StatusCode, Json<RoleDto>), ApiError> {
    state.roles.create_role(body).await.map(|role| (StatusCode::CREATED, Json(role)))
}

async fn list_roles(State(state): State<AppState>) -> Result<Json<Items<RoleDto>>, ApiError> {
    state.roles.list_roles().await.map(|items| Json(Items { items }))
}

async fn get_role(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<RoleDto>, ApiError> {
    state.roles.get_role(&id).await.map(Json)
}

async fn update_role(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<RoleDto>,
) -> Result<Json<RoleDto>, ApiError> {
    state.roles.update_role(&id, body).await.map(Json)
}

async fn delete_role(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.roles.delete_role(&id).await.map(|()| StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

async fn create_run(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateRunRequest>,
) -> Result<(StatusCode, Json<crate::transport::ports::RunDto>), ApiError> {
    state.runs.create_run(body).await.map(|run| (StatusCode::CREATED, Json(run)))
}

async fn list_runs(
    State(state): State<AppState>,
) -> Result<Json<Items<crate::transport::ports::RunDto>>, ApiError> {
    state.runs.list_runs().await.map(|items| Json(Items { items }))
}

async fn get_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<crate::transport::ports::RunDto>, ApiError> {
    state.runs.get_run(&id).await.map(Json)
}

async fn start_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<crate::transport::ports::RunDto>, ApiError> {
    state.runs.start_run(&id).await.map(Json)
}

async fn approve_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<ApprovalRequest>,
) -> Result<Json<crate::transport::ports::RunDto>, ApiError> {
    state.runs.approve(&id, &body.node_id).await.map(Json)
}

async fn reject_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<ApprovalRequest>,
) -> Result<Json<crate::transport::ports::RunDto>, ApiError> {
    let target = body.target_node_id.as_deref().ok_or_else(|| {
        ApiError::bad_request("打回请求缺少 target_node_id（必须是审批节点的传递祖先）")
    })?;
    state.runs.reject(&id, &body.node_id, target).await.map(Json)
}

async fn cancel_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<crate::transport::ports::RunDto>, ApiError> {
    state.runs.cancel_run(&id).await.map(Json)
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RunFilter {
    #[serde(rename = "runId")]
    run_id: Option<String>,
}

async fn get_artifact(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ArtifactDto>, ApiError> {
    state.artifacts.get_artifact(&id).await.map(Json)
}

async fn list_artifacts(
    State(state): State<AppState>,
    Query(filter): Query<RunFilter>,
) -> Result<Json<Items<ArtifactDto>>, ApiError> {
    state
        .artifacts
        .list_artifacts(filter.run_id.as_deref())
        .await
        .map(|items| Json(Items { items }))
}

// ---------------------------------------------------------------------------
// sandboxes
// ---------------------------------------------------------------------------

async fn prepare_sandbox(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<PrepareSandboxRequest>,
) -> Result<(StatusCode, Json<crate::transport::ports::SandboxDto>), ApiError> {
    state.sandboxes.prepare(body).await.map(|sb| (StatusCode::CREATED, Json(sb)))
}

async fn get_sandbox(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<crate::transport::ports::SandboxDto>, ApiError> {
    state.sandboxes.get_sandbox(&id).await.map(Json)
}

async fn list_sandboxes(
    State(state): State<AppState>,
    Query(filter): Query<RunFilter>,
) -> Result<Json<Items<crate::transport::ports::SandboxDto>>, ApiError> {
    state
        .sandboxes
        .list_sandboxes(filter.run_id.as_deref())
        .await
        .map(|items| Json(Items { items }))
}

async fn release_sandbox(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<crate::transport::ports::SandboxDto>, ApiError> {
    state.sandboxes.release(&id).await.map(Json)
}

// ---------------------------------------------------------------------------
// connections
// ---------------------------------------------------------------------------

async fn create_connection(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<ConnectionDto>,
) -> Result<(StatusCode, Json<ConnectionDto>), ApiError> {
    state.connections.create_connection(body).await.map(|c| (StatusCode::CREATED, Json(c)))
}

async fn list_connections(State(state): State<AppState>) -> Result<Json<Items<ConnectionDto>>, ApiError> {
    state.connections.list_connections().await.map(|items| Json(Items { items }))
}

async fn get_connection(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ConnectionDto>, ApiError> {
    state.connections.get_connection(&id).await.map(Json)
}

async fn update_connection(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<ConnectionDto>,
) -> Result<Json<ConnectionDto>, ApiError> {
    state.connections.update_connection(&id, body).await.map(Json)
}

async fn delete_connection(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.connections.delete_connection(&id).await.map(|()| StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

/// 装配全部业务资源路由。事件流与静态资源由调用方补充挂载。
pub fn business_router(state: AppState) -> Router<AppState> {
    Router::new()
        // workflows
        .route("/api/v1/workflows", post(create_workflow).get(list_workflows))
        .route(
            "/api/v1/workflows/{id}",
            get(get_workflow).put(update_workflow).delete(delete_workflow),
        )
        // roles
        .route("/api/v1/roles", post(create_role).get(list_roles))
        .route(
            "/api/v1/roles/{id}",
            get(get_role).put(update_role).delete(delete_role),
        )
        // runs
        .route("/api/v1/runs", post(create_run).get(list_runs))
        .route("/api/v1/runs/{id}", get(get_run))
        .route("/api/v1/runs/{id}/start", post(start_run))
        .route("/api/v1/runs/{id}/approve", post(approve_run))
        .route("/api/v1/runs/{id}/reject", post(reject_run))
        .route("/api/v1/runs/{id}/cancel", post(cancel_run))
        // artifacts
        .route("/api/v1/artifacts", get(list_artifacts))
        .route("/api/v1/artifacts/{id}", get(get_artifact))
        // sandboxes
        .route("/api/v1/sandboxes", post(prepare_sandbox).get(list_sandboxes))
        .route(
            "/api/v1/sandboxes/{id}",
            get(get_sandbox).delete(release_sandbox),
        )
        // connections
        .route("/api/v1/connections", post(create_connection).get(list_connections))
        .route(
            "/api/v1/connections/{id}",
            get(get_connection).put(update_connection).delete(delete_connection),
        )
        // MCP 工具调用入口
        .route("/api/v1/mcp/invoke", post(super::mcp::invoke_tool))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::ports::RunDto;

    /// 列表包络键名稳定（camelCase items）。
    #[test]
    fn items_envelope_serializes_camel_case() {
        let run = RunDto {
            id: "run-1".into(),
            status: "queued".into(),
            workflow: ursi_domain::WorkflowDefinition {
                id: "wf-1".into(),
                name: "demo".into(),
                nodes: Vec::new(),
                edges: Vec::new(),
            },
            nodes: Vec::new(),
            generation: 0,
        };
        let json = serde_json::to_value(Items { items: vec![run] }).unwrap();
        assert!(json.get("items").is_some());
    }
}
