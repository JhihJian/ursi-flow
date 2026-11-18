pub mod fake_gateway;

use std::{path::Path, time::Duration};

use reqwest::{Client, Method, StatusCode};
use serde_json::{Value, json};
use ursi_server::app::{App, AppConfig, assemble, config::GatewayConfig};

use fake_gateway::{FakeGateway, KEY, spec};

pub struct Api {
    app: App,
    client: Client,
    base: String,
}

impl Api {
    pub async fn start(dir: &Path, gateway: &FakeGateway, timeout: Duration) -> Self {
        Self::with_cleanup_interval(dir, gateway, timeout, Duration::from_secs(3600)).await
    }

    pub async fn with_cleanup_interval(
        dir: &Path,
        gateway: &FakeGateway,
        timeout: Duration,
        interval: Duration,
    ) -> Self {
        let mut config = AppConfig::for_test(dir.to_owned());
        config.listen_addr = ([0, 0, 0, 0], 0).into();
        config.cleanup_retry_interval = interval;
        config.lease_scan_interval = Duration::from_secs(3600);
        config.gateway = Some(GatewayConfig::new(gateway.url(), KEY.to_owned(), timeout));
        let app = assemble(config).await.expect("assemble application");
        let base = format!("http://127.0.0.1:{}/api/v1", app.addr().port());
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        Self { app, base, client }
    }

    pub async fn stop(self) {
        self.app.shutdown().await;
    }

    pub async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut req = self.client.request(method, format!("{}{path}", self.base));
        if let Some(body) = body {
            req = req.json(&body);
        }
        let response = req.send().await.expect("send request to assembled server");
        let status = response.status();
        let text = response.text().await.unwrap();
        assert!(!text.contains(KEY), "gateway token leaked to caller");
        (
            status,
            serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("{path}: {status}: non-JSON response: {e}: {text}")),
        )
    }

    pub async fn prepare(&self, run: &str) -> (StatusCode, Value) {
        self.call(
            Method::POST,
            "/sandboxes",
            Some(json!({"runId":run, "spec":spec()})),
        )
        .await
    }

    pub async fn live(&self, run: &str) -> (StatusCode, Value) {
        self.call(Method::GET, &format!("/sandboxes/{run}"), None)
            .await
    }

    pub async fn local(&self, run: &str) -> Value {
        let reply = self
            .call(Method::GET, &format!("/sandboxes?runId={run}"), None)
            .await;
        let list = expect(reply, StatusCode::OK);
        let items = list["items"].as_array().expect("local association list");
        assert_eq!(items.len(), 1, "{list}");
        assert_eq!(items[0]["runId"], run, "{list}");
        assert_eq!(items[0]["lastObserved"], true, "{list}");
        items[0].clone()
    }

    pub async fn release(&self, run: &str) -> (StatusCode, Value) {
        self.call(Method::DELETE, &format!("/sandboxes/{run}"), None)
            .await
    }

    pub async fn mcp(&self, tool: &str, args: Value) -> (StatusCode, Value) {
        self.call(
            Method::POST,
            "/mcp/invoke",
            Some(json!({"name":tool, "args":args})),
        )
        .await
    }

    pub async fn script_run(&self) -> String {
        expect(self.call(Method::POST, "/workflows", Some(json!({
            "id":"wf-script", "name":"script", "nodes":[{"id":"step", "name":"step", "type":"script", "script":"true", "scriptLanguage":"shell"}], "edges":[]
        }))).await, StatusCode::CREATED);
        let run = expect(
            self.call(
                Method::POST,
                "/runs",
                Some(json!({"workflowId":"wf-script"})),
            )
            .await,
            StatusCode::CREATED,
        );
        run["id"].as_str().expect("new run id").to_owned()
    }
}

pub fn expect(reply: (StatusCode, Value), status: StatusCode) -> Value {
    assert_eq!(reply.0, status, "unexpected response: {}", reply.1);
    reply.1
}
