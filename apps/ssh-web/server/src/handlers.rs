use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::extract::Path;
use axum::Json;

use crate::app::{app_state, bad_request, not_found, AppError, AppResult};
use crate::db;
use crate::models::{
    Connection, ConnectionsResponse, CreateConnectionRequest, CreateResponse, SuccessResponse,
    TestConnectionRequest, TestConnectionResponse, UpdateConnectionRequest,
};

/// `POST /api/connections/test`：验证一条尚未保存的 ssh 命令能否连上远端。
/// 只测传输层与认证（批量 ssh 执行 `hostname`），不读 tmux、不写库。
pub async fn test_connection(
    Json(request): Json<TestConnectionRequest>,
) -> AppResult<Json<TestConnectionResponse>> {
    let command = crate::models::validate_ssh_command(&request.command).map_err(bad_request)?;
    let config = Connection {
        id: 0,
        name: String::new(),
        command,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let response = match crate::session::probe_connection(&config).await {
        Ok(host) => TestConnectionResponse {
            ok: true,
            detail: (!host.is_empty()).then_some(host),
        },
        Err(error) => TestConnectionResponse {
            ok: false,
            detail: Some(format!("{error:#}")),
        },
    };
    Ok(Json(response))
}

/// `GET /api/connections`：连接列表。
pub async fn get_connections() -> AppResult<Json<ConnectionsResponse>> {
    let db = app_state().db.lock().await;
    let connections = db::list_connections(&db)?;
    Ok(Json(ConnectionsResponse { connections }))
}

/// `POST /api/connections`：新建连接（名称 + ssh 命令）。
pub async fn post_connection(
    Json(request): Json<CreateConnectionRequest>,
) -> AppResult<Response> {
    let (name, command) = request.validate().map_err(bad_request)?;
    let db = app_state().db.lock().await;
    if db::get_connection_by_name(&db, &name)?.is_some() {
        return Err(AppError::Conflict(format!("连接名已存在：{name}")));
    }
    let id = db::insert_connection(&db, &name, &command)?;
    Ok((StatusCode::CREATED, Json(CreateResponse { id })).into_response())
}

/// `PUT /api/connections/{id}`：更新连接。省略字段表示不改。
pub async fn put_connection(
    Path(id): Path<i64>,
    Json(request): Json<UpdateConnectionRequest>,
) -> AppResult<Json<SuccessResponse>> {
    let name = request.name.as_deref().map(str::trim);
    if name == Some("") {
        return Err(bad_request("name 不能为空"));
    }
    let command = match &request.command {
        Some(value) => Some(crate::models::validate_ssh_command(value).map_err(bad_request)?),
        None => None,
    };
    let db = app_state().db.lock().await;
    let updated = db::update_connection(&db, id, name, command.as_deref())?;
    if !updated {
        return Err(not_found(format!("连接 {id} 不存在")));
    }
    Ok(Json(SuccessResponse { success: true }))
}

/// `DELETE /api/connections/{id}`：删除连接。远端 tmux 会话不受影响。
pub async fn delete_connection(Path(id): Path<i64>) -> AppResult<Json<SuccessResponse>> {
    let db = app_state().db.lock().await;
    let deleted = db::delete_connection(&db, id)?;
    if !deleted {
        return Err(not_found(format!("连接 {id} 不存在")));
    }
    Ok(Json(SuccessResponse { success: true }))
}

/// `GET /api/connections/{id}`：单条连接，预留给编辑表单回填。
pub async fn get_connection(Path(id): Path<i64>) -> AppResult<Json<Connection>> {
    let db = app_state().db.lock().await;
    let connection =
        db::get_connection(&db, id)?.ok_or_else(|| not_found(format!("连接 {id} 不存在")))?;
    Ok(Json(connection))
}
