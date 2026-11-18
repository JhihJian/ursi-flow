use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};
use ursi_sandbox_client::{Acp, Error, PromptOutcome, Secret};

async fn peer() -> (String, TcpListener) {
    let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
    (
        format!(
            "ws://127.0.0.1:{}/acp",
            listener.local_addr().unwrap().port()
        ),
        listener,
    )
}
// tungstenite 的握手回调固定使用 HTTP Response 作为错误类型。
#[allow(clippy::result_large_err)]
async fn accept(listener: TcpListener) -> WebSocketStream<TcpStream> {
    let (stream, _) = listener.accept().await.unwrap();
    tokio_tungstenite::accept_hdr_async(
        stream,
        |req: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
            assert_eq!(req.headers()["authorization"], "Bearer test-session-token");
            assert!(!req.headers().contains_key("origin"));
            assert_eq!(req.uri().path_and_query().unwrap().as_str(), "/acp");
            Ok(response)
        },
    )
    .await
    .unwrap()
}
async fn recv(ws: &mut WebSocketStream<TcpStream>) -> Value {
    serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap()
}
async fn send(ws: &mut WebSocketStream<TcpStream>, value: Value) {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
async fn client(url: &str) -> Acp {
    Acp::connect(
        url,
        Secret::new("test-session-token".into()).unwrap(),
        Duration::from_secs(3),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn correlates_id_and_waits_past_multiple_notifications_for_delayed_result() {
    let (url, listener) = peer().await;
    let server = tokio::spawn(async move {
        let mut ws = accept(listener).await;
        let request = recv(&mut ws).await;
        assert_eq!(request["method"], "session/prompt");
        assert_eq!(request["params"]["sessionId"], "s1");
        // 错误 ID 和不同 JSON 类型的 ID 都不能完成当前请求。
        for id in [json!(999), json!(request["id"].to_string())] {
            send(
                &mut ws,
                json!({"jsonrpc":"2.0","id":id,"result":{"stopReason":"cancelled"}}),
            )
            .await;
        }
        for update in ["agent_message_chunk", "tool_call", "tool_call_update"] {
            send(&mut ws, json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":update,"content":{"text":"test-session-token"}}}})).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        send(
            &mut ws,
            json!({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),
        )
        .await;
    });
    let mut client = client(&url).await;
    let start = tokio::time::Instant::now();
    let mut updates = Vec::new();
    let result = client
        .request(
            "session/prompt",
            json!({"sessionId":"s1","prompt":[]}),
            |event| updates.push(event),
        )
        .await
        .unwrap();
    assert!(start.elapsed() >= Duration::from_millis(100));
    assert_eq!(updates.len(), 3);
    assert!(
        !serde_json::to_string(&updates)
            .unwrap()
            .contains("test-session-token")
    );
    assert_eq!(
        PromptOutcome::from_result(&result).unwrap(),
        PromptOutcome::Completed
    );
    server.await.unwrap();
}

#[tokio::test]
async fn rpc_error_is_failure_and_redacts_identity() {
    let (url, listener) = peer().await;
    let server = tokio::spawn(async move {
        let mut ws = accept(listener).await;
        let request = recv(&mut ws).await;
        send(&mut ws, json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32001,"message":"provider rejected test-session-token"}})).await;
    });
    let error = client(&url)
        .await
        .request("session/prompt", json!({}), |_| {})
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Rpc { code: -32001, .. }));
    assert!(!error.to_string().contains("test-session-token"));
    server.await.unwrap();
}

#[tokio::test]
async fn cancel_is_notification_and_cancelled_is_distinct_from_success() {
    let (url, listener) = peer().await;
    let server = tokio::spawn(async move {
        let mut ws = accept(listener).await;
        let request = recv(&mut ws).await;
        assert!(request.get("id").is_none());
        assert_eq!(request["method"], "session/cancel");
        assert_eq!(request["params"]["sessionId"], "s1");
        let request = recv(&mut ws).await;
        send(
            &mut ws,
            json!({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"cancelled"}}),
        )
        .await;
    });
    let mut client = client(&url).await;
    client
        .notify("session/cancel", json!({"sessionId":"s1"}))
        .await
        .unwrap();
    let result = client
        .request("session/prompt", json!({}), |_| {})
        .await
        .unwrap();
    assert_eq!(
        PromptOutcome::from_result(&result).unwrap(),
        PromptOutcome::Cancelled
    );
    server.await.unwrap();
}

#[tokio::test]
async fn notifications_do_not_extend_request_deadline() {
    let (url, listener) = peer().await;
    let server = tokio::spawn(async move {
        let mut ws = accept(listener).await;
        recv(&mut ws).await;
        loop {
            if ws
                .send(Message::Text(
                    json!({"jsonrpc":"2.0","method":"session/update","params":{}})
                        .to_string()
                        .into(),
                ))
                .await
                .is_err()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });
    let mut client = Acp::connect(
        &url,
        Secret::new("test-session-token".into()).unwrap(),
        Duration::from_millis(70),
    )
    .await
    .unwrap();
    let error = client
        .request("session/prompt", json!({}), |_| {})
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Timeout));
    server.abort();
}

#[tokio::test]
async fn disconnect_is_not_success_and_does_not_replay() {
    let (url, listener) = peer().await;
    let server = tokio::spawn(async move {
        let mut ws = accept(listener).await;
        recv(&mut ws).await;
        ws.close(None).await.unwrap();
    });
    assert!(matches!(
        client(&url)
            .await
            .request("session/prompt", json!({}), |_| {})
            .await,
        Err(Error::Closed)
    ));
    server.await.unwrap();
}

#[test]
fn only_explicit_end_turn_is_success() {
    for result in [
        json!({"success":true}),
        json!({"stopReason":"error"}),
        json!({"stopReason":"agent_settled"}),
        json!(null),
    ] {
        assert!(PromptOutcome::from_result(&result).is_err());
    }
}
