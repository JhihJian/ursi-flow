#![allow(clippy::result_large_err)]

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_tungstenite::{accept_hdr_async, tungstenite::Message};
use ursi_sandbox_client::{Error, Gateway, Secret};

#[tokio::test]
async fn gateway_uses_bearer_and_returns_accepted_lifecycle_result() {
    let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut data = Vec::new();
        loop {
            let byte = socket.read_u8().await.unwrap();
            data.push(byte);
            if data.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let request = String::from_utf8(data).unwrap().to_ascii_lowercase();
        assert!(request.starts_with("post /api/v1/sandboxes/s1/stop http/1.1"));
        assert!(request.contains("authorization: bearer gateway-secret"));
        let body = json!({"id":"s1","status":"running","operation":{"kind":"stop"}}).to_string();
        socket.write_all(format!("HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    });
    let gateway = Gateway::new(
        &url,
        Secret::new("gateway-secret".into()).unwrap(),
        Duration::from_secs(3),
    )
    .unwrap();
    let result = gateway
        .request(reqwest::Method::POST, "/api/v1/sandboxes/s1/stop", None)
        .await
        .unwrap();
    assert_eq!(result["operation"]["kind"], "stop");
    // 202 只是受理，保留实际 status 给调用方查询。
    assert_eq!(result["status"], "running");
    server.await.unwrap();
}

#[tokio::test]
async fn http_error_is_structured_and_does_not_leak_bearer() {
    let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut data = Vec::new();
        while !data.ends_with(b"\r\n\r\n") {
            data.push(socket.read_u8().await.unwrap());
        }
        let body = json!({"error":{"code":"unauthorized","message":"gateway-secret"}}).to_string();
        socket.write_all(format!("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    });
    let gateway = Gateway::new(
        &url,
        Secret::new("gateway-secret".into()).unwrap(),
        Duration::from_secs(3),
    )
    .unwrap();
    let error = gateway
        .request(reqwest::Method::GET, "/api/v1/sandboxes", None)
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Gateway { status: 401, .. }));
    assert!(!error.to_string().contains("gateway-secret"));
    server.await.unwrap();
}

#[tokio::test]
async fn bridge_uses_logical_endpoint_and_relays_bytes_with_eof() {
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
        let body = json!({"endpoints":[{
            "name":"echo","bundle":"test","protocol":"tcp","port":9001,
            "state":"ready","ready":true
        }]})
        .to_string();
        http.write_all(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(), body
        ).as_bytes()).await.unwrap();

        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = accept_hdr_async(
            stream,
            |request: &tokio_tungstenite::tungstenite::handshake::server::Request, mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                assert_eq!(request.uri().path(), "/api/v1/sandboxes/s1/connect/echo");
                assert_eq!(request.headers()["authorization"], "Bearer gateway-secret");
                assert_eq!(request.headers()["sec-websocket-protocol"], "ursi-tcp-v1");
                response
                    .headers_mut()
                    .insert("sec-websocket-protocol", "ursi-tcp-v1".parse().unwrap());
                Ok(response)
            },
        )
        .await
        .unwrap();
        assert_eq!(
            ws.next().await.unwrap().unwrap(),
            Message::Binary(b"hello".to_vec().into())
        );
        ws.send(Message::Binary(b"world".to_vec().into()))
            .await
            .unwrap();
        assert_eq!(
            ws.next().await.unwrap().unwrap(),
            Message::Text("eof".into())
        );
        ws.send(Message::Text("eof".into())).await.unwrap();
    });

    let gateway = Gateway::new(
        &url,
        Secret::new("gateway-secret".into()).unwrap(),
        Duration::from_secs(3),
    )
    .unwrap();
    let bridge = gateway
        .bridge("s1", "echo", "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let address = bridge.local_addr().unwrap();
    let (cancel, receiver) = tokio::sync::watch::channel(false);
    let runner = tokio::spawn(bridge.run_until(receiver));
    let mut local = TcpStream::connect(address).await.unwrap();
    local.write_all(b"hello").await.unwrap();
    local.shutdown().await.unwrap();
    let mut output = Vec::new();
    local.read_to_end(&mut output).await.unwrap();
    assert_eq!(output, b"world");
    cancel.send(true).unwrap();
    runner.await.unwrap().unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn bridge_handshake_failure_closes_only_local_connection() {
    let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let server = tokio::spawn(async move {
        let (mut http, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(http.read_u8().await.unwrap());
        }
        let body = json!({"endpoints":[{
            "name":"bad","bundle":"test","protocol":"tcp","port":1,
            "state":"ready","ready":true
        }]})
        .to_string();
        http.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        )
        .await
        .unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut data = [0u8; 1024];
        let size = socket.read(&mut data).await.unwrap();
        let request = String::from_utf8_lossy(&data[..size]);
        assert!(request.contains("/api/v1/sandboxes/s1/connect/bad"));
        socket
            .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
    });
    let gateway = Gateway::new(
        &url,
        Secret::new("gateway-secret".into()).unwrap(),
        Duration::from_secs(3),
    )
    .unwrap();
    let bridge = gateway
        .bridge("s1", "bad", "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let address = bridge.local_addr().unwrap();
    let (cancel, receiver) = tokio::sync::watch::channel(false);
    let runner = tokio::spawn(bridge.run_until(receiver));
    let mut local = TcpStream::connect(address).await.unwrap();
    local.write_all(b"data").await.unwrap();
    let mut output = Vec::new();
    let _ = local.read_to_end(&mut output).await;
    assert!(output.is_empty());
    cancel.send(true).unwrap();
    runner.await.unwrap().unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn endpoint_query_rejects_address_and_visibility_fields() {
    let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(socket.read_u8().await.unwrap());
        }
        let body = json!({"endpoints":[{
            "name":"ssh","bundle":"ssh","protocol":"ssh","port":2222,
            "state":"ready","ready":true,"address":"127.0.0.1:2222",
            "visibility":"public"
        }]})
        .to_string();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    let gateway = Gateway::new(
        &url,
        Secret::new("gateway-secret".into()).unwrap(),
        Duration::from_secs(3),
    )
    .unwrap();
    assert!(matches!(
        gateway.endpoints("s1").await,
        Err(Error::Protocol(_))
    ));
    server.await.unwrap();
}

#[test]
fn credential_bearing_urls_are_rejected() {
    for url in [
        "http://key@localhost",
        "http://localhost?token=x",
        "http://localhost#key",
    ] {
        assert!(
            Gateway::new(
                url,
                Secret::new("key".into()).unwrap(),
                Duration::from_secs(1)
            )
            .is_err()
        );
    }
}
