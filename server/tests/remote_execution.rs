//! Exercise production HTTP assembly against an independent ACP wire peer.
#![cfg(feature = "sandbox-access")]
use axum::{
    Json, Router,
    http::StatusCode,
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Notify,
};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};
use ursi_server::app::{AppConfig, assemble, config::GatewayConfig};

const TOKEN: &str = "test-runtime-token-only-for-this-sandbox";
const SANDBOX: &str = "sb-901";
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Success,
    Cancel,
    Disconnect,
    InvalidStop,
}

type Sock = WebSocketStream<TcpStream>;
async fn message(ws: &mut Sock, method: &str) -> Value {
    let value: Value =
        serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(value["jsonrpc"], "2.0");
    assert_eq!(value["method"], method);
    value
}
async fn send(ws: &mut Sock, value: Value) {
    ws.send(Message::text(value.to_string())).await.unwrap();
}
async fn reply(ws: &mut Sock, req: &Value, result: Value) {
    send(ws, json!({"jsonrpc":"2.0","id":req["id"],"result":result})).await;
}
async fn peer(listener: &TcpListener, mode: Mode, in_flight: Arc<Notify>) {
    let (stream, _) = listener.accept().await.unwrap();
    let mut ws = accept_hdr_async(stream, |req: &Request, resp: Response| {
        assert_eq!(req.uri().to_string(), "/acp");
        assert_eq!(req.headers()["authorization"], format!("Bearer {TOKEN}"));
        Ok(resp)
    })
    .await
    .unwrap();
    let init = message(&mut ws, "initialize").await;
    assert_eq!(
        init["params"],
        json!({"protocolVersion":1,"clientCapabilities":{}})
    );
    reply(&mut ws, &init, json!({"protocolVersion":1})).await;
    let new = message(&mut ws, "session/new").await;
    assert_eq!(
        new["params"],
        json!({"cwd":"/ursi/workspace/repo","mcpServers":[]})
    );
    let sid = "runtime-assigned-session";
    reply(&mut ws, &new, json!({"sessionId":sid})).await;
    let prompt = message(&mut ws, "session/prompt").await;
    assert_eq!(prompt["params"]["sessionId"], sid);
    let text = prompt["params"]["prompt"][0]["text"].as_str().unwrap();
    for part in ["role text", "task text", "skill instructions", "run input"] {
        assert!(text.contains(part));
    }
    in_flight.notify_one();
    let stop = match mode {
        Mode::Success => {
            for chunk in ["real ", "wire"] {
                send(&mut ws,json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":sid,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":chunk}}}})).await;
            }
            "end_turn"
        }
        Mode::Cancel => {
            let cancel = message(&mut ws, "session/cancel").await;
            assert!(cancel.get("id").is_none());
            assert_eq!(cancel["params"], json!({"sessionId":sid}));
            "cancelled"
        }
        Mode::Disconnect => return,
        Mode::InvalidStop => {
            reply(&mut ws, &prompt, json!({})).await;
            return;
        }
    };
    reply(&mut ws, &prompt, json!({"stopReason":stop})).await;
    let close = message(&mut ws, "_ursi/session/close").await;
    assert_eq!(close["params"], json!({"sessionId":sid}));
    reply(&mut ws, &close, json!({})).await;
}

async fn post_json(url: String, body: Value, expected: StatusCode) -> Value {
    let resp = reqwest::Client::new()
        .post(url)
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = resp.status();
    let body: Value = resp.json().await.unwrap();
    assert_eq!(status, expected, "{body}");
    assert!(!body.to_string().contains(TOKEN));
    body
}

async fn scenario(mode: Mode) {
    let dir = tempfile::tempdir().unwrap();
    let creds = tempfile::tempdir().unwrap();
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(creds.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let addr = SocketAddr::from(([127, 0, 0, 1], listener.local_addr().unwrap().port()));
    let observations = Arc::new(AtomicUsize::new(0));
    let observed = observations.clone();
    let gateway = Router::new().route("/api/v1/sandboxes",post(|| async { (StatusCode::ACCEPTED,Json(json!({"id":SANDBOX,"status":"preparing","operation":{"kind":"create"},"endpoints":[]}))) }))
        .route(&format!("/api/v1/sandboxes/{SANDBOX}"),get(move || { observed.fetch_add(1,Ordering::Relaxed); async move { Json(json!({"id":SANDBOX,"status":"running","operation":null,"endpoints":[{"name":"ssh","address":"127.0.0.1:1","port":2222,"visibility":"public"},{"name":"session","address":addr.to_string(),"port":8765,"visibility":"internal"}]})) } }).delete(|| async { (StatusCode::NOT_FOUND,Json(json!({"error":{"code":"not_found","message":"gone"}}))) }));
    let gw = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let mut cfg = AppConfig::for_test(dir.path().into());
    cfg.cleanup_retry_interval = Duration::from_secs(3600);
    cfg.gateway = Some(GatewayConfig::new(
        format!("http://127.0.0.1:{}", gw.local_addr().unwrap().port()),
        "different-control-key".into(),
        Duration::from_secs(3),
    ));
    cfg.acp_bindings_dir = Some(creds.path().into());
    cfg.listen_addr = ([0, 0, 0, 0], 0).into();
    let gateway = tokio::spawn(async move { axum::serve(gw, gateway).await.unwrap() });
    let app = assemble(cfg).await.unwrap();
    let base = format!("http://127.0.0.1:{}/api/v1", app.addr().port());
    let conn = post_json(format!("{base}/connections"),json!({"id":"c","name":"c","serviceType":"openai_compatible","endpoint":"https://example.test","credentialRef":"vault://provider"}),StatusCode::CREATED).await;
    post_json(format!("{base}/roles"),json!({"id":"r","name":"r","prompt":"role text","model":"test-model","executorKind":"pi","connectionId":conn["id"],"skills":[{"path":"SKILL.md","content":"skill instructions"}],"mcpServers":[]}),StatusCode::CREATED).await;
    post_json(format!("{base}/workflows"),json!({"id":"w","name":"w","nodes":[{"id":"n","type":"agent","name":"task text","roleId":"r","maxAttempts":3}]}),StatusCode::CREATED).await;
    let run = post_json(
        format!("{base}/runs"),
        json!({"workflowId":"w", "input":"run input"}),
        StatusCode::CREATED,
    )
    .await;
    let run = run["id"].as_str().unwrap();
    let start = format!("{base}/runs/{run}/start");
    post_json(format!("{base}/sandboxes"),json!({"runId":run,"spec":{"image":"test","runtime_profile":"pi","ports":[{"name":"session","port":8765,"visibility":"internal","ready":true}]}}),StatusCode::ACCEPTED).await;
    let file = creds.path().join(format!("{run}.json"));
    post_json(start.clone(), Value::Null, StatusCode::SERVICE_UNAVAILABLE).await;
    let wrong_addr = SocketAddr::from(([127, 0, 0, 1], 1));
    for (sandbox, pinned) in [
        ("another-sandbox", addr),
        (SANDBOX, wrong_addr),
        (SANDBOX, addr),
    ] {
        let mut binding = tempfile::NamedTempFile::new_in(creds.path()).unwrap();
        serde_json::to_writer(
            &mut binding,
            &json!({"sandbox_id":sandbox,"address":pinned,"token":TOKEN,"model":"test-model"}),
        )
        .unwrap();
        binding.persist(&file).unwrap();
        if sandbox != SANDBOX || pinned != addr {
            post_json(start.clone(), Value::Null, StatusCode::SERVICE_UNAVAILABLE).await;
        }
    }
    let in_flight = Arc::new(Notify::new());
    let signal = in_flight.clone();
    let responder = tokio::spawn(async move {
        peer(&listener, mode, signal).await;
        listener
    });
    let uncertain = matches!(mode, Mode::Disconnect | Mode::InvalidStop);
    let command = tokio::spawn(post_json(
        start.clone(),
        Value::Null,
        if uncertain {
            StatusCode::CONFLICT
        } else {
            StatusCode::OK
        },
    ));
    if mode == Mode::Cancel {
        in_flight.notified().await;
        let result = post_json(
            format!("{base}/runs/{run}/cancel"),
            Value::Null,
            StatusCode::OK,
        )
        .await;
        assert_eq!(result["status"], "cancelled");
    }
    let result = command.await.unwrap();
    let listener = responder.await.unwrap();
    if uncertain {
        // start is also the recovery entry point. Neither maxAttempts nor another
        // start may create another connection to submit this task.
        post_json(start, Value::Null, StatusCode::CONFLICT).await;
        let run: Value = reqwest::get(format!("{base}/runs/{run}"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(run["nodes"][0]["status"], "running");
        assert_eq!(run["nodes"][0]["attempt"], 1);
    } else {
        assert_eq!(result["nodes"][0]["attempt"], 1);
        if mode == Mode::Success {
            assert_eq!(result["status"], "succeeded");
            assert_eq!(result["nodes"][0]["output"], "real wire");
        } else {
            assert_eq!(result["status"], "cancelled");
        }
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
    assert!(observations.load(Ordering::Relaxed) >= 3);
    app.shutdown().await;
    gateway.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bound_agent_completes_and_closes() {
    tokio::time::timeout(Duration::from_secs(10), scenario(Mode::Success))
        .await
        .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_reaches_the_active_session() {
    tokio::time::timeout(Duration::from_secs(10), scenario(Mode::Cancel))
        .await
        .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_acknowledgement_is_not_replayed() {
    for mode in [Mode::Disconnect, Mode::InvalidStop] {
        tokio::time::timeout(Duration::from_secs(10), scenario(mode))
            .await
            .unwrap();
    }
}
