use serde_json::json;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
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
