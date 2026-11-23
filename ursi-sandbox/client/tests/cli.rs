#![allow(clippy::result_large_err)]

use std::process::Command;

#[test]
fn help_describes_gateway_only_endpoint_access() {
    let help = Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(help.status.success());
    let help_text = String::from_utf8_lossy(&help.stdout);
    assert!(help_text.contains("URSI_GATEWAY_KEY"));
    assert!(help_text.contains("forward SANDBOX_ID ENDPOINT_NAME"));
    assert!(!help_text.contains("HOST PORT"));
    assert_eq!(help_text.contains("acp initialize"), cfg!(feature = "acp"));
    assert_eq!(
        help_text.contains("URSI_ACP_ENDPOINT"),
        cfg!(feature = "acp")
    );
}

#[cfg(not(feature = "acp"))]
#[test]
fn core_cli_does_not_dispatch_acp() {
    let output = Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .args(["acp", "initialize"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("未知命令"));
}

#[cfg(feature = "acp")]
#[test]
fn direct_acp_url_is_rejected() {
    let output = Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .args(["acp", "initialize"])
        .env("URSI_ACP_URL", "ws://127.0.0.1:1/acp")
        .env_remove("URSI_SANDBOX_ID")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("URSI_SANDBOX_ID"));
}

#[test]
fn unknown_arguments_fail() {
    let output = Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .args(["gateway", "list", "unexpected"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn ssh_config_prints_static_block_without_credentials() {
    let output = Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .arg("ssh-config")
        .env_remove("URSI_GATEWAY_KEY")
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.starts_with("Host ursi-*\n"));
    assert!(text.contains("  User agent\n"));
    assert!(text.contains(" proxy %h ssh\n"));
    assert!(text.contains("  StrictHostKeyChecking accept-new\n"));
    assert!(text.contains("  IdentityFile ~/.ursi/id_ed25519\n"));
    assert!(!text.contains("URSI_GATEWAY_KEY"));
    assert!(!text.contains("Bearer"));
}

#[test]
fn ssh_config_ignore_policy_drops_host_key_pinning() {
    let output = Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .args([
            "ssh-config",
            "--host-key-policy",
            "ignore",
            "--known-hosts",
            "/private/known_hosts",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("  StrictHostKeyChecking no\n"));
    assert!(text.contains("  UserKnownHostsFile /dev/null\n"));
    assert!(!text.contains("accept-new"));
}

#[test]
fn ssh_config_rejects_unknown_policy() {
    let output = Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .args(["ssh-config", "--host-key-policy", "maybe"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("pin"));
}

#[test]
fn proxy_rejects_hosts_without_sandbox_prefix() {
    let output = Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .args(["proxy", "example.com"])
        .env("URSI_GATEWAY_URL", "http://127.0.0.1:1")
        .env("URSI_GATEWAY_KEY", "unused-secret")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("ursi-"));
}

/// 保活 Ping 与 Pong 不是数据，断言时跳过。
async fn next_data(
    ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
) -> tokio_tungstenite::tungstenite::Message {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;
    loop {
        match ws.next().await.unwrap().unwrap() {
            Message::Ping(_) | Message::Pong(_) => continue,
            other => return other,
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proxy_relays_stdio_bytes_without_result_line() {
    use futures_util::SinkExt;
    use std::io::Write as _;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let server = tokio::spawn(async move {
        let (mut http, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(http.read_u8().await.unwrap());
        }
        let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /api/v1/sandboxes/s1/endpoints http/1.1"));
        assert!(request.contains("authorization: bearer gateway-secret"));
        let body = serde_json::json!({"endpoints":[{
            "name":"ssh","bundle":"test","protocol":"ssh","port":2222,
            "state":"ready","ready":true
        }]})
        .to_string();
        http.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        )
        .await
        .unwrap();
        drop(http);

        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_hdr_async(
            stream,
            |request: &Request, mut response: Response| {
                assert_eq!(request.uri().path(), "/api/v1/sandboxes/s1/connect/ssh");
                assert_eq!(request.headers()["authorization"], "Bearer gateway-secret");
                response
                    .headers_mut()
                    .insert("sec-websocket-protocol", "ursi-tcp-v1".parse().unwrap());
                Ok(response)
            },
        )
        .await
        .unwrap();
        assert_eq!(
            next_data(&mut ws).await,
            Message::Binary(b"ssh-banner".to_vec().into())
        );
        assert_eq!(next_data(&mut ws).await, Message::Text("eof".into()));
        ws.send(Message::Binary(b"ok".to_vec().into()))
            .await
            .unwrap();
        ws.send(Message::Text("eof".into())).await.unwrap();
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .args(["proxy", "ursi-s1"])
        .env("URSI_GATEWAY_URL", &url)
        .env("URSI_GATEWAY_KEY", "gateway-secret")
        .env_remove("URSI_GATEWAY_KEY_FILE")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"ssh-banner").unwrap();
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"ok");
    server.await.unwrap();
}

/// 标准输出是行缓冲，客户端必须在收到不含换行的报文后立刻 flush，否则对端会一直等。
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn proxy_flushes_payload_without_newline_before_eof() {
    use futures_util::SinkExt;
    use std::io::Write as _;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    let payload = b"payload-without-newline";
    let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let expected = payload.to_vec();
    let server = tokio::spawn(async move {
        let (mut http, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(http.read_u8().await.unwrap());
        }
        let body = serde_json::json!({"endpoints":[{
            "name":"ssh","bundle":"test","protocol":"ssh","port":2222,
            "state":"ready","ready":true
        }]})
        .to_string();
        http.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        )
        .await
        .unwrap();
        drop(http);

        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_hdr_async(
            stream,
            |_request: &Request, mut response: Response| {
                response
                    .headers_mut()
                    .insert("sec-websocket-protocol", "ursi-tcp-v1".parse().unwrap());
                Ok(response)
            },
        )
        .await
        .unwrap();
        assert_eq!(
            next_data(&mut ws).await,
            Message::Binary(b"first".to_vec().into())
        );
        ws.send(Message::Binary(expected.into())).await.unwrap();
        assert_eq!(next_data(&mut ws).await, Message::Text("eof".into()));
        ws.send(Message::Text("eof".into())).await.unwrap();
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .args(["proxy", "ursi-s1"])
        .env("URSI_GATEWAY_URL", &url)
        .env("URSI_GATEWAY_KEY", "gateway-secret")
        .env_remove("URSI_GATEWAY_KEY_FILE")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"first").unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let expected_len = payload.len();
    let received = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::task::spawn_blocking(move || {
            use std::io::Read as _;
            let mut buffer = vec![0u8; expected_len];
            stdout.read_exact(&mut buffer).unwrap();
            buffer
        }),
    )
    .await
    .expect("stdout 在 EOF 之前没有收到报文")
    .unwrap();
    assert_eq!(received, payload);
    drop(stdin);
    assert!(child.wait().unwrap().success());
    server.await.unwrap();
}
