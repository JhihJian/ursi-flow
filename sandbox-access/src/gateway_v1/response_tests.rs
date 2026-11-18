//! 协议边界反例：对端返回独立构造的响应，不复用 wire DTO。

use super::HttpGatewayClient;
use axum::{Router, http::StatusCode, response::Redirect, routing::get};
use flow_core::sandboxes::{
    GatewayClient, GatewayError, GatewaySandboxStatus, PrepareStatus, SandboxSpec, Visibility,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

async fn serve(router: Router) -> HttpGatewayClient {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    HttpGatewayClient::new(url, "test-token-not-for-forwarding", Duration::from_secs(5))
}

async fn reply(status: StatusCode, body: String) -> HttpGatewayClient {
    serve(Router::new().fallback(move || async move { (status, body) })).await
}

fn sandbox() -> Value {
    json!({"id":"sbx-1", "status":"running", "operation":null, "endpoints":[], "future_field":1})
}

#[tokio::test]
async fn 每个方法只接受契约状态码() {
    let c = reply(StatusCode::ACCEPTED, sandbox().to_string()).await;
    assert!(matches!(
        c.get("sbx-1").await,
        Err(GatewayError::Protocol(_))
    ));
    let mut deleting = sandbox();
    deleting["operation"] = json!({"kind":"delete"});
    deleting["status"] = json!("deleting");
    let c = reply(StatusCode::OK, deleting.to_string()).await;
    assert!(matches!(
        c.prepare("op", &SandboxSpec::default()).await,
        Err(GatewayError::Protocol(_))
    ));
    assert!(matches!(
        c.release("sbx-1").await,
        Err(GatewayError::Protocol(_))
    ));
}

#[tokio::test]
async fn 畸形响应与错误身份不产生回执() {
    for malformed in [
        "not-json",
        "{}",
        r#"{"id":"", "status":"running", "operation":null, "endpoints":[]}"#,
        r#"{"id":"sbx-1", "status":"new_status", "operation":null, "endpoints":[]}"#,
    ] {
        let c = reply(StatusCode::ACCEPTED, malformed.into()).await;
        assert!(matches!(
            c.prepare("op", &SandboxSpec::default()).await,
            Err(GatewayError::Protocol(_))
        ));
        assert!(matches!(
            c.release("sbx-1").await,
            Err(GatewayError::Protocol(_))
        ));
    }
    let c = reply(StatusCode::OK, sandbox().to_string()).await;
    assert!(matches!(
        c.get("sbx-other").await,
        Err(GatewayError::Protocol(_))
    ));
    let mut deleting = sandbox();
    deleting["operation"] = json!({"kind":"delete"});
    deleting["status"] = json!("deleting");
    let c = reply(StatusCode::ACCEPTED, deleting.to_string()).await;
    assert!(matches!(
        c.release("sbx-other").await,
        Err(GatewayError::Protocol(_))
    ));
    let c = reply(StatusCode::ACCEPTED, sandbox().to_string()).await;
    assert!(matches!(
        c.release("sbx-1").await,
        Err(GatewayError::Protocol(_))
    ));
    // 同键重试也可能收到 running 的创建回执，仍需 GET 核实。
    assert_eq!(
        c.prepare("op", &SandboxSpec::default())
            .await
            .unwrap()
            .status,
        PrepareStatus::Accepted
    );
}

#[tokio::test]
async fn get要求显式操作与合法端点() {
    let mut missing = sandbox();
    missing.as_object_mut().unwrap().remove("operation");
    let mut malformed = vec![missing];
    for operation in [
        json!(false),
        json!({}),
        json!({"kind":"future"}),
        json!({"kind":"rebuild"}),
    ] {
        let mut v = sandbox();
        v["operation"] = operation;
        malformed.push(v);
    }
    for endpoint in [
        json!({"name":"web", "port":80, "address":"127.0.0.1:80"}),
        json!({"name":"web", "port":80, "address":"127.0.0.1:80", "visibility":"future"}),
    ] {
        let mut v = sandbox();
        v["endpoints"] = json!([endpoint]);
        malformed.push(v);
    }
    for v in malformed {
        let c = reply(StatusCode::OK, v.to_string()).await;
        assert!(
            matches!(c.get("sbx-1").await, Err(GatewayError::Protocol(_))),
            "{v}"
        );
    }
    let mut v = sandbox();
    v["operation"] = json!({"kind":"stop", "future":1});
    v["endpoints"] = json!([{"name":"ssh", "port":22, "visibility":"internal", "address":"172.16.0.1:22", "future":1}]);
    let c = reply(StatusCode::OK, v.to_string()).await;
    let view = c.get("sbx-1").await.unwrap();
    assert_eq!(view.status, GatewaySandboxStatus::Running);
    assert!(view.operation_pending);
    assert!(matches!(view.endpoints[0].visibility, Visibility::Internal));
    assert_eq!(view.endpoints[0].address, "172.16.0.1:22");
}

#[tokio::test]
async fn 不把代理的裸404当作资源消失() {
    let c = reply(StatusCode::NOT_FOUND, "<html>Not Found</html>".into()).await;
    assert!(matches!(
        c.get("sbx-1").await,
        Err(GatewayError::Protocol(_))
    ));
    assert!(matches!(
        c.release("sbx-1").await,
        Err(GatewayError::Protocol(_))
    ));
}

#[tokio::test]
async fn 带认证的请求不跟随重定向() {
    let redirected = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&redirected);
    let c = serve(
        Router::new()
            .route(
                "/api/v1/sandboxes/{id}",
                get(|| async { Redirect::temporary("/elsewhere") }),
            )
            .route(
                "/elsewhere",
                get(move || async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    sandbox().to_string()
                }),
            ),
    )
    .await;
    assert!(matches!(
        c.get("sbx-1").await,
        Err(GatewayError::Protocol(_))
    ));
    assert_eq!(redirected.load(Ordering::SeqCst), 0);
}
