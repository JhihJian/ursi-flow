use axum::extract::{Path, State};
use axum::Json;

use crate::app::{app_state, bad_request, not_found, AppResult};
use crate::db;
use crate::models::{
    Connection, ConnectionsResponse, CreateConnectionRequest, CreateResponse, SuccessResponse,
    UpdateConnectionRequest,
};

/// `GET /api/connections`：连接列表。响应不包含密码与私钥口令。
pub async fn get_connections() -> AppResult<Json<ConnectionsResponse>> {
    let db = app_state().db.lock().await;
    let connections = db::list_connections(&db)?;
    Ok(Json(ConnectionsResponse { connections }))
}

/// `POST /api/connections`：新建连接。
pub async fn post_connection(
    State(_): State<()>,
    Json(request): Json<CreateConnectionRequest>,
) -> AppResult<Json<CreateResponse>> {
    request.validate().map_err(bad_request)?;
    let name = request.name.trim().to_string();
    let db = app_state().db.lock().await;
    if db::get_connection_by_name(&db, &name)?.is_some() {
        return Err(crate::app::AppError::Conflict(format!(
            "连接名已存在：{name}"
        )));
    }
    let fields = db::NewConnection {
        name: &name,
        host: request.host.trim(),
        port: request.resolved_port(),
        username: request.username.trim(),
        auth_type: request.auth_type,
        password: request.resolved_password(),
        key_path: request.resolved_key_path(),
        key_passphrase: request.resolved_key_passphrase(),
    };
    let id = db::insert_connection(&db, &fields)?;
    Ok(Json(CreateResponse { id }))
}

/// `PUT /api/connections/{id}`：更新连接。
/// password 省略/null/空串表示保持不变，其余字段可任意更新。
pub async fn put_connection(
    State(_): State<()>,
    Path(id): Path<i64>,
    Json(request): Json<UpdateConnectionRequest>,
) -> AppResult<Json<SuccessResponse>> {
    if request.name.as_deref().map(str::trim) == Some("") {
        return Err(bad_request("name 不能为空"));
    }
    if let Some(port) = request.port {
        if !(1..=65535).contains(&port) {
            return Err(bad_request(format!("port 超出范围：{port}")));
        }
    }
    let (password_keep, password) = match &request.password {
        None | Some(None) => (true, None),
        Some(Some(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                (true, None)
            } else {
                (false, Some(trimmed.to_string()))
            }
        }
    };
    let db = app_state().db.lock().await;
    let update = db::ConnectionUpdate {
        name: request.name.as_deref(),
        host: request.host.as_deref(),
        port: request.port,
        username: request.username.as_deref(),
        auth_type: request.auth_type,
        password_keep,
        password: password.as_deref(),
        key_path: request.key_path.as_ref().map(|s| s.as_deref()),
        key_passphrase: request.key_passphrase.as_ref().map(|s| s.as_deref()),
    };
    let updated = db::update_connection(&db, id, &update)?;
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

/// `GET /api/connections/{id}`：单条连接（不含密码），预留给编辑表单刷新。
pub async fn get_connection(Path(id): Path<i64>) -> AppResult<Json<Connection>> {
    let db = app_state().db.lock().await;
    let connection =
        db::get_connection(&db, id)?.ok_or_else(|| not_found(format!("连接 {id} 不存在")))?;
    Ok(Json(connection))
}
