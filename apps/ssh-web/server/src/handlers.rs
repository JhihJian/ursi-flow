use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::extract::Path;
use axum::Json;
use serde::Deserialize;

use crate::app::{app_state, bad_request, not_found, AppError, AppResult};
use crate::db;
use crate::location::is_valid_device;
use crate::models::{
    Connection, ConnectionsResponse, CreateConnectionRequest, CreateResponse,
    DiscoverSshHostsResponse, ImportConnectionsResponse, ImportFailure, SshArgsResponse,
    SuccessResponse, TestConnectionRequest, TestConnectionResponse, UpdateConnectionRequest,
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
    insert_connection_unique(&name, &command).await
}

/// 同名校验 + 写库。连接发现与手工新建共用同一入口，重名直接 409。
async fn insert_connection_unique(name: &str, command: &str) -> AppResult<Response> {
    let db = app_state().db.lock().await;
    if db::get_connection_by_name(&db, name)?.is_some() {
        return Err(AppError::Conflict(format!("连接名已存在：{name}")));
    }
    let id = db::insert_connection(&db, name, command)?;
    Ok((StatusCode::CREATED, Json(CreateResponse { id })).into_response())
}

#[derive(Debug, Deserialize)]
pub struct ImportConnectionsRequest {
    pub connections: Vec<CreateConnectionRequest>,
}

/// `POST /api/connections/import`：批量导入连接（来自 ssh config 发现）。
/// 每条独立校验与插入：单条失败跳过并记入 `failed`，其余照常导入。
pub async fn import_connections(
    Json(request): Json<ImportConnectionsRequest>,
) -> AppResult<Json<ImportConnectionsResponse>> {
    let mut imported = Vec::new();
    let mut failed = Vec::new();
    for entry in request.connections {
        let name = entry.name.trim().to_string();
        let display = if name.is_empty() {
            "（空名称）".to_string()
        } else {
            name.clone()
        };
        match entry.validate() {
            Ok((name, command)) => {
                let db = app_state().db.lock().await;
                if db::get_connection_by_name(&db, &name)?.is_some() {
                    failed.push(ImportFailure {
                        name: display,
                        reason: "同名连接已存在".into(),
                    });
                } else {
                    let id = db::insert_connection(&db, &name, &command)?;
                    imported.push(CreateResponse { id });
                }
            }
            Err(reason) => failed.push(ImportFailure { name: display, reason }),
        }
    }
    Ok(Json(ImportConnectionsResponse { imported, failed }))
}

/// `GET /api/ssh-config/hosts`：从本机 `~/.ssh/config` 发现可批量导入的主机。
pub async fn discover_ssh_hosts() -> AppResult<Json<DiscoverSshHostsResponse>> {
    let hosts = crate::ssh_config::discover_hosts()
        .await
        .map_err(|error| AppError::Internal(error))?;
    Ok(Json(DiscoverSshHostsResponse { hosts }))
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

/// `GET /api/connections/by-name/{name}/ssh-args`：按连接名取 ssh 调用参数。
/// `name` 就是位置契约 `ssh://<设备名>/path` 里的设备名，先按设备名规则校验，
/// 不合法直接 400，不查库。
pub async fn get_ssh_args(Path(name): Path<String>) -> AppResult<Json<SshArgsResponse>> {
    if !is_valid_device(&name) {
        return Err(bad_request(format!("非法设备名：{name}")));
    }
    let db = app_state().db.lock().await;
    let connection = db::get_connection_by_name(&db, &name)?
        .ok_or_else(|| not_found(format!("连接 {name} 不存在")))?;
    Ok(Json(SshArgsResponse {
        id: connection.id,
        name: connection.name,
        args: crate::session::command_ssh_args(&connection.command),
    }))
}
