use crate::{
    Outbox, RpcError,
    config::{EVENT_QUEUE, MAX_MESSAGE},
    response,
    sessions::Sessions,
};
use axum::{
    Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc, watch};

#[derive(Clone)]
struct App {
    sessions: Arc<Sessions>,
    connections: Arc<Semaphore>,
}
pub async fn serve(sessions: Arc<Sessions>) -> std::io::Result<()> {
    let app = App {
        sessions: sessions.clone(),
        connections: Arc::new(Semaphore::new(16)),
    };
    let router = Router::new()
        .route("/healthz", get(|| async { "ok\n" }))
        .route("/acp", get(upgrade))
        .with_state(app);
    let address = std::env::var("URSI_SESSION_LISTEN").unwrap_or_else(|_| "0.0.0.0:8765".into());
    let listener = tokio::net::TcpListener::bind(address).await?;
    eprintln!("session-service: listening");
    let shutdown_sessions = sessions.clone();
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("signal unavailable");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
            shutdown_sessions.shutdown().await;
        })
        .await
}
async fn upgrade(
    State(app): State<App>,
    uri: Uri,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if headers.contains_key("origin") || uri.query().is_some() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let auth = headers.get_all("authorization");
    if auth.iter().count() != 1 {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let supplied = auth
        .iter()
        .next()
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    let expected = app.sessions.config.token.as_bytes();
    let bytes = supplied.as_bytes();
    let mut difference = bytes.len() ^ expected.len();
    for (i, &byte) in expected.iter().enumerate() {
        difference |= (byte ^ bytes.get(i).copied().unwrap_or(0)) as usize;
    }
    if difference != 0 {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let permit = match app.connections.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    ws.max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            connection(socket, app.sessions).await;
        })
}
async fn connection(socket: WebSocket, sessions: Arc<Sessions>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Value>(EVENT_QUEUE);
    let (disconnect, mut closed) = watch::channel(false);
    let output = Outbox {
        tx,
        disconnect: disconnect.clone(),
        active: Arc::new(Mutex::new(HashSet::new())),
    };
    let mut writer_closed = closed.clone();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = writer_closed.changed() => break,
                value = rx.recv() => {
                    let Some(value) = value else { break };
                    if !matches!(tokio::time::timeout(Duration::from_secs(5), sink.send(Message::Text(value.to_string().into()))).await, Ok(Ok(()))) { break; }
                }
            }
        }
        disconnect.send_replace(true);
    });
    let mut initialized = false;
    loop {
        let message = tokio::select! { biased; _ = closed.changed() => break, message = stream.next() => message };
        let text = match message {
            Some(Ok(Message::Text(text))) => text,
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            _ => break,
        };
        let request: Value = match serde_json::from_str(&text) {
            Ok(request) => request,
            Err(_) => {
                output.send(response(
                    Value::Null,
                    Err(RpcError {
                        code: -32700,
                        message: "parse error",
                    }),
                ));
                continue;
            }
        };
        let id = request.get("id").cloned();
        if !request.is_object()
            || request["jsonrpc"] != "2.0"
            || !request["method"].is_string()
            || id.as_ref().is_some_and(|id| {
                !(id.is_i64() || id.is_u64() || id.as_str().is_some_and(|s| s.len() <= 128))
            })
        {
            output.send(response(
                Value::Null,
                Err(RpcError {
                    code: -32600,
                    message: "invalid request",
                }),
            ));
            continue;
        }
        let method = request["method"].as_str().unwrap();
        if id.is_none() {
            if initialized && method == "session/cancel" {
                if let Ok(id) = session_id(&request["params"]) {
                    let _ = sessions.cancel(id).await;
                }
            }
            continue;
        }
        let id = id.unwrap();
        {
            let mut active = output.active.lock().unwrap();
            // 重复在途 ID 会使响应歧义，立即断开连接，已有任务继续运行。
            if active.len() >= 128 || !active.insert(id.to_string()) {
                break;
            }
        }
        let params = &request["params"];
        let result = if method == "initialize" {
            if initialized {
                Err(RpcError::business("already initialized"))
            } else if params["protocolVersion"] != 1 || !params["clientCapabilities"].is_object() {
                Err(RpcError::params(
                    "protocolVersion 1 and clientCapabilities required",
                ))
            } else {
                initialized = true;
                Ok(Some(
                    json!({"protocolVersion":1,"agentInfo":{"name":"ursi-pi","version":env!("CARGO_PKG_VERSION")},"agentCapabilities":{"loadSession":false,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},"mcpCapabilities":{"http":false,"sse":false}}}),
                ))
            }
        } else if !initialized {
            Err(RpcError::business("initialize required"))
        } else {
            dispatch(&sessions, method, params, id.clone(), output.clone()).await
        };
        match result {
            Ok(None) => {}
            Ok(Some(result)) => output.send(response(id, Ok(result))),
            Err(error) => output.send(response(id, Err(error))),
        }
    }
    output.disconnect.send_replace(true);
    writer.abort();
}
fn session_id(params: &Value) -> Result<&str, RpcError> {
    params["sessionId"]
        .as_str()
        .filter(|id| id.len() <= 128 && !id.is_empty())
        .ok_or_else(|| RpcError::params("sessionId required"))
}
async fn dispatch(
    sessions: &Arc<Sessions>,
    method: &str,
    params: &Value,
    id: Value,
    output: Outbox,
) -> Result<Option<Value>, RpcError> {
    match method {
        "session/new" => {
            let cwd = params["cwd"]
                .as_str()
                .ok_or_else(|| RpcError::params("cwd required"))?;
            if !params["mcpServers"].as_array().is_some_and(Vec::is_empty) {
                return Err(RpcError::params("mcpServers must be an empty array"));
            }
            sessions.new_session(cwd).await.map(Some)
        }
        "session/prompt" => {
            let session = session_id(params)?;
            let blocks = params["prompt"]
                .as_array()
                .filter(|b| !b.is_empty())
                .ok_or_else(|| RpcError::params("nonempty text prompt required"))?;
            let mut prompt = Vec::new();
            for block in blocks {
                if block["type"] != "text" {
                    return Err(RpcError::params("only text prompt blocks are supported"));
                }
                prompt.push(
                    block["text"]
                        .as_str()
                        .ok_or_else(|| RpcError::params("text block requires text"))?,
                );
            }
            let prompt = prompt.join("\n");
            if prompt.trim().is_empty() {
                return Err(RpcError::params("nonempty text prompt required"));
            }
            sessions.prompt(session, prompt, id, output).await?;
            Ok(None)
        }
        "_ursi/session/status" => sessions.status(session_id(params)?).await.map(Some),
        "_ursi/session/close" => {
            let session = session_id(params)?.to_string();
            // close 可能等待清理，不能阻塞同一连接的 cancel/status。
            let sessions = sessions.clone();
            tokio::spawn(async move {
                output.send(response(id, sessions.close(&session).await));
            });
            Ok(None)
        }
        "session/cancel" => Err(RpcError::params("session/cancel is a notification")),
        _ => Err(RpcError {
            code: -32601,
            message: "method not found",
        }),
    }
}
