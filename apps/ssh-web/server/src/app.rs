use std::sync::OnceLock;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::Connection;
use serde::Deserialize;
use tokio::sync::{mpsc, Mutex};

use crate::db;
use crate::session::{
    valid_tmux_session, ControlMessage, WsEvent, EVENT_CAPACITY, INPUT_CAPACITY,
    WS_TEXT_LIMIT_BYTES,
};

/// 全局共享状态：连接库。会话状态完全由远端 tmux 承担，服务端无状态。
pub struct AppState {
    pub db: Mutex<Connection>,
}

static APP: OnceLock<AppState> = OnceLock::new();

/// 初始化全局状态，重复初始化视为程序错误。
pub fn init_app(db: Connection) {
    if APP.set(AppState { db: Mutex::new(db) }).is_err() {
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

/// `GET /api/connections/{id}/tmux-sessions`：列出远端 tmux 会话。
pub async fn get_tmux_sessions(
    Path(id): Path<i64>,
) -> AppResult<Json<crate::models::TmuxSessionsResponse>> {
    let config = load_connection(id).await?;
    let sessions = crate::session::list_tmux_sessions(&config)
        .await
        .map_err(|error| AppError::Ssh(format!("{error:#}")))?;
    Ok(Json(crate::models::TmuxSessionsResponse { sessions }))
}

async fn load_connection(id: i64) -> AppResult<crate::db::Connection> {
    let db = app_state().db.lock().await;
    db::get_connection(&db, id)?.ok_or_else(|| not_found(format!("连接 {id} 不存在")))
}

#[derive(Debug, Deserialize)]
pub struct TerminalQuery {
    tmux_session: Option<String>,
    /// 初始 PTY 尺寸，取自前端终端面板实际大小，避免 80×24 闪排。
    cols: Option<u32>,
    rows: Option<u32>,
}

/// 校验初始尺寸，缺省或非法时回退 80×24。
fn initial_size(query: &TerminalQuery) -> (u32, u32) {
    const MAX: u32 = 500;
    match (query.cols, query.rows) {
        (Some(cols), Some(rows)) if (2..=MAX).contains(&cols) && (2..=MAX).contains(&rows) => {
            (cols, rows)
        }
        _ => (80, 24),
    }
}

/// `GET /api/connections/{id}/terminal`：终端 WebSocket。
///
/// 升级即建 SSH：连接、认证、开 PTY 并执行 tmux 启动命令（无 tmux 回退普通 shell）。
/// 认证失败、主机不可达等错误以 `{"type":"error"}` 文本帧下发后关闭 WS。
/// WS 关闭即断 SSH；远端 tmux 会话不受影响。
pub async fn get_terminal_ws(
    Path(id): Path<i64>,
    Query(query): Query<TerminalQuery>,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    let config = load_connection(id).await?;
    let tmux_session = match &query.tmux_session {
        Some(name) => {
            if !valid_tmux_session(name) {
                return Err(bad_request(format!("非法 tmux 会话名：{name}")));
            }
            name.clone()
        }
        None => crate::session::DEFAULT_TMUX_SESSION.to_string(),
    };

    let (cols, rows) = initial_size(&query);
    let (event_tx, event_rx) = mpsc::channel::<WsEvent>(EVENT_CAPACITY);
    let (input_tx, input_rx) = mpsc::channel::<ControlMessage>(INPUT_CAPACITY);
    tokio::spawn(crate::session::run_terminal(
        config,
        Some(tmux_session),
        cols,
        rows,
        input_rx,
        event_tx,
    ));

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
                        break;
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
