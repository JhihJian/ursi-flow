use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{net::TcpListener, process::Command};
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn cli_prompt_emits_updates_and_distinguishes_all_terminal_outcomes() {
    for (result, expected) in [
        (json!({"result":{"stopReason":"end_turn"}}), 0),
        (json!({"result":{"stopReason":"cancelled"}}), 2),
        (
            json!({"error":{"code":-32000,"message":"failed secret-token"}}),
            1,
        ),
        (json!({"result":{"stopReason":"max_tokens"}}), 1),
    ] {
        let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
        let url = format!(
            "ws://127.0.0.1:{}/acp",
            listener.local_addr().unwrap().port()
        );
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let initialize: Value =
                serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(initialize["method"], "initialize");
            ws.send(Message::Text(
                json!({"jsonrpc":"2.0","id":initialize["id"],"result":{"protocolVersion":1}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
            let prompt: Value =
                serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(prompt["method"], "session/prompt");
            assert_eq!(prompt["params"]["prompt"][0]["text"], "fix the function");
            ws.send(Message::Text(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","status":"in_progress"}}}).to_string().into())).await.unwrap();
            let mut response = result;
            response["jsonrpc"] = json!("2.0");
            response["id"] = prompt["id"].clone();
            ws.send(Message::Text(response.to_string().into()))
                .await
                .unwrap();
        });
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("prompt.txt");
        std::fs::write(&path, "fix the function").unwrap();
        let token = temp.path().join("token");
        std::fs::write(&token, "secret-token\n").unwrap();
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
                .args(["acp", "prompt", "s1"])
                .arg(path)
                .env("URSI_ACP_URL", url)
                .env_remove("URSI_SESSION_TOKEN")
                .env("URSI_SESSION_TOKEN_FILE", token)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(output.status.code(), Some(expected));
        assert!(String::from_utf8_lossy(&output.stdout).contains("tool_call"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("secret-token"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("secret-token"));
        server.await.unwrap();
    }
}

#[test]
fn help_does_not_require_credentials_and_unknown_arguments_fail() {
    let help = std::process::Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("URSI_SESSION_TOKEN"));
    let unknown = std::process::Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .args(["gateway", "list", "unexpected"])
        .output()
        .unwrap();
    assert_eq!(unknown.status.code(), Some(1));
}
