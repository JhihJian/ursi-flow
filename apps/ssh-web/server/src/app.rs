use std::sync::OnceLock;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::Connection;
use tokio::sync::{mpsc, Mutex};

use crate::db;
use crate::models::ConnectRequest;
use crate::session::{
    Attach, ControlMessage, SessionRegistry, WsEvent, WS_INPUT_CAPACITY, WS_TEXT_LIMIT_BYTES,
};

/// 全局共享状态：连接库 + 会话注册表。
pub struct AppState {
    pub db: Mutex<Connection>,
    pub registry: SessionRegistry,
}

static APP: OnceLock<AppState> = OnceLock::new();

/// 初始化全局状态，重复初始化视为程序错误。
pub fn init_app(db: Connection) {
    if APP
        .set(AppState {
            db: Mutex::new(db),
            registry: SessionRegistry::new(),
        })
        .is_err()
    {
        panic!("app state 重复初始化");
    }
}

/// 处理器里直接取全局状态；未初始化时 panic 属于程序缺陷。
pub fn app_state() -> &'static AppState {
    APP.get().expect("app state 未初始化")
}

pub type AppResult<T> = Result<T, AppError>;

/// API 错误：统一转 JSON `{error, code}`。
#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    NotFound(String),
    Conflict(String),
    /// 上游 SSH 失败（连接不上、认证失败等），消息直接面向用户。
    Ssh(String),
    Internal(anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, error) = match self {
            AppError::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad_request", message),
            AppError::NotFound(message) => (StatusCode::NOT_FOUND, "not_found", message),
            AppError::Conflict(message) => (StatusCode::CONFLICT, "conflict", message),
            AppError::Ssh(message) => (StatusCode::BAD_GATEWAY, "ssh_error", message),
            AppError::Internal(error) => {
                println!("内部错误：{error:#}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "内部错误".to_string(),
                )
            }
        };
        let body = serde_json::json!({ "error": error, "code": code });
        (status, Json(body)).into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(error: E) -> Self {
        AppError::Internal(error.into())
    }
}

pub fn bad_request(message: impl Into<String>) -> AppError {
    AppError::BadRequest(message.into())
}

pub fn not_found(message: impl Into<String>) -> AppError {
    AppError::NotFound(message.into())
}

/// `POST /api/connections/{id}/connect`：建立 SSH 会话。
pub async fn post_connect(
    State(_): State<()>,
    Path(id): Path<i64>,
    Json(request): Json<ConnectRequest>,
) -> AppResult<Json<crate::models::ConnectResponse>> {
    let config = {
        let db = app_state().db.lock().await;
        db::get_connection(&db, id)?.ok_or_else(|| not_found(format!("连接 {id} 不存在")))?
    };
    let cols = request.cols.unwrap_or(80).clamp(1, 500);
    let rows = request.rows.unwrap_or(24).clamp(1, 500);
    let info = app_state()
        .registry
        .connect(&config, cols, rows)
        .await
        .map_err(AppError::Ssh)?;
    Ok(Json(crate::models::ConnectResponse { session: info }))
}

/// `GET /api/sessions/{id}/ws`：接入会话的终端 WebSocket。
///
/// 接入后先创建配对通道再交给会话任务，随后循环：
/// - SSH 数据（binary）原样转发为 WS binary 帧；
/// - input/resize 控制消息交给会话任务写入 SSH；
/// - 会话任务退出后关闭 WS。
pub async fn get_session_ws(Path(id): Path<String>, ws: WebSocketUpgrade) -> AppResult<Response> {
    let state = app_state();
    let info = state
        .registry
        .get(&id)
        .await
        .ok_or_else(|| not_found(format!("会话 {id} 不存在")))?;
    if info.attached {
        return Err(bad_request(format!("会话 {id} 已有终端接入")));
    }

    let (event_tx, event_rx) = mpsc::channel::<WsEvent>(WS_INPUT_CAPACITY);
    let (input_tx, input_rx) = mpsc::channel::<ControlMessage>(WS_INPUT_CAPACITY);
    let attached = state
        .registry
        .attach(&id, Attach { input_rx, event_tx })
        .await;
    if !attached {
        return Err(AppError::Conflict(format!("会话 {id} 已结束，无法接入")));
    }

    Ok(ws.on_upgrade(move |socket| run_ws_socket(socket, event_rx, input_tx)))
}

async fn run_ws_socket(
    mut socket: WebSocket,
    mut event_rx: mpsc::Receiver<WsEvent>,
    input_tx: mpsc::Sender<ControlMessage>,
) {
    loop {
        tokio::select! {
            event = event_rx.recv() => {
                match event {
                    Some(WsEvent::Data(bytes)) => {
                        if socket.send(Message::Binary(bytes)).await.is_err() {
                            break;
                        }
                    }
                    Some(WsEvent::Error { message }) => {
                        let text = serde_json::to_string(&serde_json::json!({
                            "type": "error",
                            "message": message,
                        }))
                        .unwrap_or_default();
                        let _ = socket.send(Message::Text(text.into())).await;
                    }
                    Some(WsEvent::Closed { message }) => {
                        let text = serde_json::to_string(&serde_json::json!({
                            "type": "closed",
                            "message": message,
                        }))
                        .unwrap_or_default();
                        let _ = socket.send(Message::Text(text.into())).await;
                        break;
                    }
                    None => break,
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(control) = parse_control(&text) {
                            if input_tx.send(control).await.is_err() {
                                break;
                            }
                        }
                    }
                    // 二进制帧与非法帧都直接断开：协议只允许 JSON 文本。
                    Some(Ok(Message::Binary(_))) | Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                    Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                }
            }
        }
    }
    // socket 被 drop 时自动发送 close 帧。
}

/// 解析 WS 文本帧为控制消息。超限或格式非法的帧直接丢弃。
fn parse_control(text: &str) -> Option<ControlMessage> {
    if text.len() > WS_TEXT_LIMIT_BYTES {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    match value.get("type")?.as_str()? {
        "input" => {
            let data = value.get("data")?.as_str()?;
            Some(ControlMessage::Input(data.to_string()))
        }
        "resize" => {
            let cols = value.get("cols")?.as_u64()?;
            let rows = value.get("rows")?.as_u64()?;
            if cols == 0 || rows == 0 || cols > 500 || rows > 500 {
                return None;
            }
            Some(ControlMessage::Resize {
                cols: cols as u32,
                rows: rows as u32,
            })
        }
        _ => None,
    }
}
