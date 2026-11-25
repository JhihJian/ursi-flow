use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use ursi_sandbox_client::{
    Secret,
    acp::{Acp, PromptOutcome},
};

#[tokio::test]
async fn another_connection_cancels_pending_prompt_then_status_and_close_work() {
    let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let url = format!(
        "ws://127.0.0.1:{}/acp",
        listener.local_addr().unwrap().port()
    );
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut prompt_ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        let prompt: Value =
            serde_json::from_str(prompt_ws.next().await.unwrap().unwrap().to_text().unwrap())
                .unwrap();
        assert_eq!(prompt["method"], "session/prompt");
        started_tx.send(()).unwrap();
        let (stream, _) = listener.accept().await.unwrap();
        let mut control = tokio_tungstenite::accept_async(stream).await.unwrap();
        let cancel: Value =
            serde_json::from_str(control.next().await.unwrap().unwrap().to_text().unwrap())
                .unwrap();
        assert_eq!(cancel["method"], "session/cancel");
        assert!(cancel.get("id").is_none());
        assert_eq!(cancel["params"]["sessionId"], prompt["params"]["sessionId"]);
        prompt_ws
            .send(Message::Text(
                json!({"jsonrpc":"2.0","id":prompt["id"],"result":{"stopReason":"cancelled"}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        for (method, result) in [
            (
                "_ursi/session/status",
                json!({"sessionId":"s1","state":"cancelled","pid":null}),
            ),
            ("_ursi/session/close", json!({})),
        ] {
            let request: Value =
                serde_json::from_str(control.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(request["method"], method);
            control
                .send(Message::Text(
                    json!({"jsonrpc":"2.0","id":request["id"],"result":result})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        }
    });
    let mut prompt = Acp::connect(
        &url,
        Secret::new("token".into()).unwrap(),
        Duration::from_secs(3),
    )
    .await
    .unwrap();
    let pending = tokio::spawn(async move {
        prompt
            .request(
                "session/prompt",
                json!({"sessionId":"s1","prompt":[]}),
                |_| {},
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), started_rx)
        .await
        .unwrap()
        .unwrap();
    let mut control = Acp::connect(
        &url,
        Secret::new("token".into()).unwrap(),
        Duration::from_secs(3),
    )
    .await
    .unwrap();
    control
        .notify("session/cancel", json!({"sessionId":"s1"}))
        .await
        .unwrap();
    let result = pending.await.unwrap().unwrap();
    assert_eq!(
        PromptOutcome::from_result(&result).unwrap(),
        PromptOutcome::Cancelled
    );
    let status = control
        .request("_ursi/session/status", json!({"sessionId":"s1"}), |_| {})
        .await
        .unwrap();
    assert_eq!(status["state"], "cancelled");
    assert!(status["pid"].is_null());
    assert_eq!(
        control
            .request("_ursi/session/close", json!({"sessionId":"s1"}), |_| {})
            .await
            .unwrap(),
        json!({})
    );
    server.await.unwrap();
}
