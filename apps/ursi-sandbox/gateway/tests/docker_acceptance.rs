//! 独立进程 + 真实 Docker 验收，不依赖 server、runtime 或 ACP。
//! cargo test -p ursi-gateway --test docker_acceptance -- --ignored --nocapture
//! 日志和 SQLite 保留在输出的临时目录，Docker 清理严格限定随机 scope。
#![cfg(feature = "driver-docker")]

use std::{
    fs::OpenOptions,
    path::PathBuf,
    process::{Child, Command, Output, Stdio},
    sync::OnceLock,
    time::{Duration, Instant},
};

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Error as WsError, Message, client::IntoClientRequest},
};
use uuid::Uuid;

const IMAGE: &str = "ursi-gateway-acceptance:local";
const WAIT: Duration = Duration::from_secs(45);
const POLL: Duration = Duration::from_millis(100);
const TAIL: &[u8] = b"\nfixture-tail-after-eof\n";

fn docker_output(args: &[&str]) -> Output {
    // timeout 也约束 Drop 中的同步清理，避免 Docker daemon 故障挂死测试。
    Command::new("timeout")
        .args(["--kill-after=2s", "30s", "docker"])
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("cannot run docker {args:?}: {error}"))
}

fn docker(args: &[&str]) -> String {
    let output = docker_output(args);
    assert!(
        output.status.success(),
        "docker {args:?}: status={} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn build_fixture() {
    static BUILD: OnceLock<()> = OnceLock::new();
    BUILD.get_or_init(|| {
        let context = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/docker");
        docker(&[
            "build",
            "--pull=false",
            "--network=none",
            "-t",
            IMAGE,
            context.to_str().unwrap(),
        ]);
    });
}

struct Gateway {
    scope: String,
    key: String,
    artifacts: PathBuf,
    child: Option<Child>,
    base: String,
    client: Client,
}

impl Gateway {
    fn new() -> Self {
        build_fixture();
        let scope = format!("acceptance-{}", Uuid::new_v4().simple());
        let artifacts = tempfile::Builder::new()
            .prefix(&scope)
            .tempdir()
            .unwrap()
            .keep();
        eprintln!("Docker scope={scope}, artifacts={}", artifacts.display());
        Self {
            scope,
            key: Uuid::new_v4().simple().to_string(),
            artifacts,
            child: None,
            base: String::new(),
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
        }
    }

    async fn start(&mut self, tunnel: bool) {
        assert!(
            self.child.is_none(),
            "kill and reap previous process before restart"
        );
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.artifacts.join("gateway.log"))
            .unwrap();
        let previous_log_size = log.metadata().unwrap().len() as usize;
        self.child = Some(
            Command::new(env!("CARGO_BIN_EXE_ursi-gateway"))
                .env("URSI_GATEWAY_KEY", &self.key)
                .env("URSI_GATEWAY_NAMESPACE", &self.scope)
                .env("URSI_GATEWAY_DB", self.artifacts.join("gateway.sqlite"))
                .env("URSI_GATEWAY_DRIVER", "docker")
                .env("URSI_GATEWAY_BIND", "0.0.0.0:0")
                .env("URSI_GATEWAY_PUBLIC_BIND", "0.0.0.0")
                .env("URSI_GATEWAY_ADVERTISE_HOST", "127.0.0.1")
                .env("URSI_GATEWAY_TUNNEL", if tunnel { "true" } else { "false" })
                .stdin(Stdio::null())
                .stdout(Stdio::from(log.try_clone().unwrap()))
                .stderr(Stdio::from(log))
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + WAIT;
        loop {
            assert!(
                Instant::now() < deadline,
                "gateway startup deadline, logs={}",
                self.artifacts.display()
            );
            assert!(
                self.child.as_mut().unwrap().try_wait().unwrap().is_none(),
                "gateway exited during startup: {}",
                self.logs()
            );
            let log = self.logs();
            if let Some(address) = log
                .get(previous_log_size..)
                .unwrap_or("")
                .lines()
                .find_map(|line| line.strip_prefix("ursi-gateway listening on "))
            {
                let port = address.rsplit(':').next().unwrap();
                self.base = format!("http://127.0.0.1:{port}");
                if self
                    .client
                    .get(format!("{}/healthz", self.base))
                    .send()
                    .await
                    .is_ok_and(|response| response.status().is_success())
                {
                    break;
                }
            }
            sleep(POLL).await;
        }
    }

    fn logs(&self) -> String {
        std::fs::read_to_string(self.artifacts.join("gateway.log")).unwrap_or_default()
    }

    fn kill(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            // try_wait 成功时会回收子进程，文件锁释放后才能启动同库进程。
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => {
                        // 已确认退出，wait 立即返回并明确完成 kill + wait 契约。
                        let _ = child.wait();
                        break;
                    }
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    result => {
                        eprintln!("failed to reap gateway before deadline: {result:?}");
                        self.child = Some(child);
                        assert!(std::thread::panicking(), "gateway kill/reap failed");
                        break;
                    }
                }
            }
        }
    }

    async fn api(&self, method: Method, path: &str, body: Option<Value>, expected: u16) -> Value {
        let mut request = self
            .client
            .request(method.clone(), format!("{}{path}", self.base))
            .bearer_auth(&self.key);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        assert_eq!(
            status,
            expected,
            "{method} {path}: {text}, logs={}",
            self.artifacts.display()
        );
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("invalid JSON: {error}: {text}"))
    }

    async fn create(&self) -> Value {
        self.api(Method::POST, "/api/v1/sandboxes", Some(spec()), 202)
            .await
    }

    async fn get(&self, id: &str) -> Value {
        self.api(Method::GET, &format!("/api/v1/sandboxes/{id}"), None, 200)
            .await
    }

    async fn settled(&self, id: &str, status: &str) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            let value = self.get(id).await;
            if value["status"] == status && value["operation"].is_null() {
                return value;
            }
            assert!(
                Instant::now() < deadline,
                "{id} never settled to {status}: {value}, artifacts={}",
                self.artifacts.display()
            );
            sleep(POLL).await;
        }
    }

    async fn action(&self, id: &str, action: &str, body: Option<Value>) -> Value {
        // 周期对账短暂持有同沙箱锁，契约明确允许调用方重试 409。
        let deadline = Instant::now() + WAIT;
        loop {
            let mut request = self
                .client
                .post(format!("{}/api/v1/sandboxes/{id}/{action}", self.base))
                .bearer_auth(&self.key);
            if let Some(body) = &body {
                request = request.json(body);
            }
            let response = request.send().await.unwrap();
            if response.status().as_u16() == 409 && Instant::now() < deadline {
                sleep(POLL).await;
                continue;
            }
            let status = response.status().as_u16();
            let value: Value = response.json().await.unwrap();
            assert_eq!(status, 202, "{action}: {value}");
            return value;
        }
    }

    fn container(&self, sandbox: &Value) -> String {
        format!(
            "{}-{}-r{}",
            self.scope,
            sandbox["id"].as_str().unwrap(),
            sandbox["resource"]["generation"]
        )
    }

    fn inspect(&self, sandbox: &Value) -> Value {
        serde_json::from_str::<Value>(&docker(&["container", "inspect", &self.container(sandbox)]))
            .unwrap()[0]
            .clone()
    }

    fn sentinel(&self, sandbox: &Value, name: &str, value: &str) {
        docker(&[
            "exec",
            &self.container(sandbox),
            "sh",
            "-c",
            "printf '%s' \"$2\" > \"/ursi/workspace/$1\"",
            "sh",
            name,
            value,
        ]);
    }

    fn assert_sentinel(&self, sandbox: &Value, name: &str, expected: Option<&str>) {
        let output = docker_output(&[
            "exec",
            &self.container(sandbox),
            "cat",
            &format!("/ursi/workspace/{name}"),
        ]);
        match expected {
            Some(value) => {
                assert!(
                    output.status.success(),
                    "sentinel lost: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                assert_eq!(String::from_utf8_lossy(&output.stdout), value);
            }
            None => {
                assert!(!output.status.success());
                assert!(
                    String::from_utf8_lossy(&output.stderr).contains("No such file"),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
    }

    async fn side_effect_before_ready(&self, sandbox: &Value) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            let output = docker_output(&["container", "inspect", &self.container(sandbox)]);
            if output.status.success() {
                let inspect = serde_json::from_slice::<Value>(&output.stdout).unwrap()[0].clone();
                if inspect["State"]["Running"] == true {
                    let current = self.get(sandbox["id"].as_str().unwrap()).await;
                    assert_eq!(
                        current["status"], "preparing",
                        "missed pre-ready crash window: {current}"
                    );
                    assert!(!current["operation"].is_null());
                    assert_ne!(inspect["State"]["Health"]["Status"], "healthy");
                    return inspect;
                }
            }
            assert!(
                Instant::now() < deadline,
                "container side effect missing: {}, inspect stderr={}",
                self.container(sandbox),
                String::from_utf8_lossy(&output.stderr)
            );
            sleep(POLL).await;
        }
    }

    fn scoped(&self, kind: &str, id: Option<&str>) -> Vec<String> {
        let scope = format!("label=io.ursi.scope={}", self.scope);
        let id_filter = id.map(|id| format!("label=io.ursi.id={id}"));
        let mut args = if kind == "container" {
            vec!["container", "ls", "-aq"]
        } else {
            vec!["volume", "ls", "-q"]
        };
        args.extend(["--filter", &scope]);
        if let Some(filter) = &id_filter {
            args.extend(["--filter", filter]);
        }
        docker(&args).lines().map(str::to_owned).collect()
    }

    async fn delete(&self, id: &str) {
        let deadline = Instant::now() + WAIT;
        loop {
            let response = self
                .client
                .delete(format!("{}/api/v1/sandboxes/{id}", self.base))
                .bearer_auth(&self.key)
                .send()
                .await
                .unwrap();
            if response.status().as_u16() == 409 && Instant::now() < deadline {
                sleep(POLL).await;
                continue;
            }
            assert_eq!(response.status().as_u16(), 202);
            break;
        }
        loop {
            let response = self
                .client
                .get(format!("{}/api/v1/sandboxes/{id}", self.base))
                .bearer_auth(&self.key)
                .send()
                .await
                .unwrap();
            if response.status().as_u16() == 404 {
                break;
            }
            assert_eq!(response.status().as_u16(), 200);
            assert!(Instant::now() < deadline, "delete deadline for {id}");
            sleep(POLL).await;
        }
        assert!(self.scoped("container", Some(id)).is_empty());
        assert!(self.scoped("volume", Some(id)).is_empty());
    }

    async fn ws_rejected(
        &self,
        id: &str,
        endpoint: &str,
        protocol: &str,
        origin: bool,
        query: &str,
        expected: u16,
    ) {
        let mut request = format!(
            "{}/api/v1/sandboxes/{id}/connect/{endpoint}{query}",
            self.base.replace("http://", "ws://")
        )
        .into_client_request()
        .unwrap();
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {}", self.key).parse().unwrap(),
        );
        request
            .headers_mut()
            .insert("sec-websocket-protocol", protocol.parse().unwrap());
        if origin {
            request
                .headers_mut()
                .insert("origin", "https://example.invalid".parse().unwrap());
        }
        let deadline = Instant::now() + WAIT;
        loop {
            let result = timeout(Duration::from_secs(5), connect_async(request.clone()))
                .await
                .unwrap();
            match result {
                Err(WsError::Http(response))
                    if expected == 404
                        && response.status().as_u16() == 409
                        && Instant::now() < deadline =>
                {
                    sleep(POLL).await
                }
                Err(WsError::Http(response)) => {
                    assert_eq!(response.status().as_u16(), expected, "{response:?}");
                    break;
                }
                other => panic!("expected WS rejection {expected}, got {other:?}"),
            }
        }
    }

    async fn tunnel_roundtrip(&self, id: &str) {
        let deadline = Instant::now() + WAIT;
        let (mut socket, response) = loop {
            let mut request = format!(
                "{}/api/v1/sandboxes/{id}/connect/echo",
                self.base.replace("http://", "ws://")
            )
            .into_client_request()
            .unwrap();
            request.headers_mut().insert(
                "authorization",
                format!("Bearer {}", self.key).parse().unwrap(),
            );
            request
                .headers_mut()
                .insert("sec-websocket-protocol", "ursi-tcp-v1".parse().unwrap());
            match timeout(Duration::from_secs(12), connect_async(request))
                .await
                .unwrap()
            {
                Ok(connected) => break connected,
                Err(WsError::Http(response))
                    if response.status().as_u16() == 409 && Instant::now() < deadline =>
                {
                    sleep(POLL).await
                }
                other => panic!("tunnel connect: {other:?}"),
            }
        };
        assert_eq!(response.headers()["sec-websocket-protocol"], "ursi-tcp-v1");
        let payload: Vec<u8> = (0..100_000).map(|index| (index % 251) as u8).collect();
        let mut expected = payload.clone();
        expected.extend_from_slice(TAIL);
        timeout(Duration::from_secs(10), async {
            for chunk in payload.chunks(32 * 1024) {
                socket
                    .send(Message::Binary(chunk.to_vec().into()))
                    .await
                    .unwrap();
            }
            socket.send(Message::Text("eof".into())).await.unwrap();
            let mut received = Vec::new();
            loop {
                match socket
                    .next()
                    .await
                    .expect("closed before output EOF")
                    .unwrap()
                {
                    Message::Binary(bytes) => received.extend_from_slice(&bytes),
                    Message::Text(text) => {
                        assert_eq!(text, "eof");
                        break;
                    }
                    Message::Ping(_) | Message::Pong(_) => {}
                    message => panic!("unexpected before output EOF: {message:?}"),
                }
            }
            assert_eq!(received, expected, "half-close lost bytes or post-EOF tail");
            loop {
                match socket.next().await {
                    None | Some(Ok(Message::Close(_))) => break,
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    message => panic!("expected tunnel close: {message:?}"),
                }
            }
        })
        .await
        .expect("tunnel half-close deadline");
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.kill();
        // 不调用会 panic 的 docker()，确保失败展开时仍尽力清理所有本次 scope。
        for kind in ["container", "volume"] {
            let filter = format!("label=io.ursi.scope={}", self.scope);
            let listing = if kind == "container" {
                docker_output(&["container", "ls", "-aq", "--filter", &filter])
            } else {
                docker_output(&["volume", "ls", "-q", "--filter", &filter])
            };
            if !listing.status.success() {
                eprintln!(
                    "cleanup listing {kind} failed: {}",
                    String::from_utf8_lossy(&listing.stderr)
                );
                continue;
            }
            for resource in String::from_utf8_lossy(&listing.stdout).lines() {
                if resource.is_empty() {
                    continue;
                }
                let output = if kind == "container" {
                    // 保存容器日志，即使断言失败也可以定位 fixture 问题。
                    let logs = docker_output(&["logs", resource]);
                    let _ = std::fs::write(
                        self.artifacts.join(format!("container-{resource}.log")),
                        [logs.stdout, logs.stderr].concat(),
                    );
                    docker_output(&["container", "rm", "-f", resource])
                } else {
                    docker_output(&["volume", "rm", resource])
                };
                if !output.status.success() {
                    eprintln!(
                        "cleanup {kind} {resource} failed: {}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
            }
        }
        eprintln!(
            "Gateway artifacts retained: {}\n{}",
            self.artifacts.display(),
            self.logs()
        );
    }
}

fn spec() -> Value {
    json!({"image": IMAGE, "ports": [
        {"name": "web", "port": 8080, "visibility": "public", "ready": true},
        {"name": "echo", "port": 9001, "visibility": "internal", "ready": true}
    ]})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires Docker"]
async fn docker_lifecycle_security_and_internal_tunnel() {
    let mut gateway = Gateway::new();
    gateway.start(false).await;
    for token in [None, Some("wrong-key")] {
        let mut request = gateway
            .client
            .get(format!("{}/api/v1/sandboxes", gateway.base));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status().as_u16(), 401);
        assert_eq!(response.headers()["www-authenticate"], "Bearer");
        assert_eq!(
            response.json::<Value>().await.unwrap()["error"]["code"],
            "unauthorized"
        );
    }
    gateway.api(Method::GET, "/api/v1/unknown", None, 404).await;
    gateway
        .api(Method::GET, "/api/v1/sandboxes/missing", None, 404)
        .await;
    gateway
        .api(Method::GET, "/api/v1/sandboxes/bad%20id", None, 400)
        .await;
    let mut unknown = spec();
    unknown["publish"] = json!(true);
    gateway
        .api(Method::POST, "/api/v1/sandboxes", Some(unknown), 400)
        .await;
    for (name, port) in [
        ("cdp", 9001),
        ("novnc", 9001),
        ("other", 9222),
        ("other", 6080),
    ] {
        gateway
            .api(
                Method::POST,
                "/api/v1/sandboxes",
                Some(json!({"image": IMAGE, "ports": [
                    {"name": name, "port": port, "visibility": "public"}
                ]})),
                400,
            )
            .await;
    }
    let mut invalid = spec();
    invalid["ports"][1]["publish"] = json!(true);
    gateway
        .api(Method::POST, "/api/v1/sandboxes", Some(invalid), 400)
        .await;
    let mut invalid = spec();
    invalid["ports"][0]["port"] = json!(0);
    gateway
        .api(Method::POST, "/api/v1/sandboxes", Some(invalid), 400)
        .await;
    assert!(gateway.scoped("container", None).is_empty());
    let capabilities = gateway
        .api(Method::GET, "/api/v1/capabilities", None, 200)
        .await;
    assert_eq!(capabilities["driver"], "docker");
    assert_eq!(
        capabilities["capabilities"],
        json!({"rebuild_preserve_data": true, "rebuild_destroy_data": true})
    );
    assert_eq!(capabilities["tunnel_enabled"], false);
    gateway
        .ws_rejected("missing", "echo", "ursi-tcp-v1", false, "", 501)
        .await;
    gateway.kill();
    gateway.start(true).await;
    assert_eq!(
        gateway
            .api(Method::GET, "/api/v1/capabilities", None, 200)
            .await["tunnel_enabled"],
        true
    );

    let (first, second) = tokio::join!(gateway.create(), gateway.create());
    let first_id = first["id"].as_str().unwrap();
    let second_id = second["id"].as_str().unwrap();
    let (mut first, second) = tokio::join!(
        gateway.settled(first_id, "running"),
        gateway.settled(second_id, "running")
    );
    let first_id = first["id"].as_str().unwrap().to_owned();
    let second_id = second["id"].as_str().unwrap().to_owned();
    let second_container = gateway.inspect(&second)["Id"].clone();
    gateway.sentinel(&second, "neighbor", "untouched");
    assert_eq!(
        gateway
            .api(Method::GET, "/api/v1/sandboxes", None, 200)
            .await["sandboxes"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let endpoints = gateway
        .api(
            Method::GET,
            &format!("/api/v1/sandboxes/{first_id}/endpoints"),
            None,
            200,
        )
        .await;
    assert_eq!(endpoints["endpoints"].as_array().unwrap().len(), 2);
    let web = endpoints["endpoints"]
        .as_array()
        .unwrap()
        .iter()
        .find(|ep| ep["name"] == "web")
        .unwrap();
    let response = gateway
        .client
        .get(format!("http://{}/", web["address"].as_str().unwrap()))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.text().await.unwrap(), "gateway-acceptance\n");
    let inspect = gateway.inspect(&first);
    let bindings = inspect["HostConfig"]["PortBindings"].as_object().unwrap();
    assert_eq!(
        bindings.len(),
        1,
        "only public endpoint may publish: {bindings:?}"
    );
    assert_eq!(bindings["8080/tcp"][0]["HostIp"], "0.0.0.0");
    assert!(inspect["NetworkSettings"]["Ports"]["9001/tcp"].is_null());
    assert_eq!(inspect["State"]["Health"]["Status"], "healthy");
    assert_eq!(inspect["HostConfig"]["CapDrop"], json!(["ALL"]));
    let logs = gateway
        .api(
            Method::GET,
            &format!("/api/v1/sandboxes/{first_id}/logs?tail=20"),
            None,
            200,
        )
        .await;
    assert!(logs["content"].as_str().unwrap().contains("fixture-ready"));
    gateway
        .ws_rejected(&first_id, "echo", "wrong-protocol", false, "", 400)
        .await;
    gateway
        .ws_rejected(&first_id, "echo", "ursi-tcp-v1", true, "", 400)
        .await;
    gateway
        .ws_rejected(
            &first_id,
            "echo",
            "ursi-tcp-v1",
            false,
            "?token=forbidden",
            400,
        )
        .await;
    gateway
        .ws_rejected(&first_id, "missing", "ursi-tcp-v1", false, "", 404)
        .await;
    gateway.tunnel_roundtrip(&first_id).await;

    let original_container = inspect["Id"].clone();
    gateway.sentinel(&first, "data", "must-survive");
    gateway.action(&first_id, "stop", None).await;
    let stopped = gateway.settled(&first_id, "stopped").await;
    assert_eq!(stopped["endpoints"], json!([]));
    assert_eq!(gateway.inspect(&stopped)["State"]["Running"], false);
    gateway.action(&first_id, "start", None).await;
    first = gateway.settled(&first_id, "running").await;
    assert_eq!(gateway.inspect(&first)["Id"], original_container);
    gateway.assert_sentinel(&first, "data", Some("must-survive"));
    for preserve in [true, false] {
        let previous_container = gateway.inspect(&first)["Id"].clone();
        let previous_resource = first["resource"].clone();
        gateway
            .action(
                &first_id,
                "rebuild",
                Some(json!({"preserve_data": preserve})),
            )
            .await;
        first = gateway.settled(&first_id, "running").await;
        assert_ne!(gateway.inspect(&first)["Id"], previous_container);
        assert!(
            first["resource"]["generation"].as_u64().unwrap()
                > previous_resource["generation"].as_u64().unwrap()
        );
        assert_eq!(
            first["resource"]["data_generation"] == previous_resource["data_generation"],
            preserve
        );
        gateway.assert_sentinel(&first, "data", preserve.then_some("must-survive"));
        assert_eq!(gateway.scoped("container", Some(&first_id)).len(), 1);
        assert_eq!(gateway.scoped("volume", Some(&first_id)).len(), 1);
    }
    gateway.delete(&first_id).await;
    assert_eq!(gateway.get(&second_id).await["status"], "running");
    assert_eq!(gateway.inspect(&second)["Id"], second_container);
    gateway.assert_sentinel(&second, "neighbor", Some("untouched"));
    gateway.tunnel_roundtrip(&second_id).await;
    gateway.delete(&second_id).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires Docker"]
async fn docker_recovers_create_and_both_rebuild_modes_after_sigkill() {
    let mut gateway = Gateway::new();
    gateway.start(true).await;
    let mut sandbox = gateway.create().await;
    let id = sandbox["id"].as_str().unwrap().to_owned();
    let created = gateway.side_effect_before_ready(&sandbox).await;
    gateway.kill();
    gateway.sentinel(&sandbox, "create-crash", "created-before-ready");
    gateway.start(true).await;
    sandbox = gateway.settled(&id, "running").await;
    assert_eq!(
        gateway.inspect(&sandbox)["Id"],
        created["Id"],
        "create recovery replaced original container"
    );
    gateway.assert_sentinel(&sandbox, "create-crash", Some("created-before-ready"));

    for preserve in [true, false] {
        let previous = sandbox.clone();
        let old_container = gateway.inspect(&previous)["Id"].clone();
        gateway.sentinel(&previous, "old-data", "old-generation");
        sandbox = gateway
            .action(&id, "rebuild", Some(json!({"preserve_data": preserve})))
            .await;
        let new_container = gateway.side_effect_before_ready(&sandbox).await;
        assert_ne!(new_container["Id"], old_container);
        gateway.kill();
        gateway.assert_sentinel(&sandbox, "old-data", preserve.then_some("old-generation"));
        gateway.sentinel(&sandbox, "new-data", "new-generation-must-not-be-deleted");
        gateway.start(true).await;
        let recovered = gateway.settled(&id, "running").await;
        assert_eq!(recovered["resource"], sandbox["resource"]);
        assert_eq!(
            gateway.inspect(&recovered)["Id"],
            new_container["Id"],
            "rebuild recovery replaced new container"
        );
        gateway.assert_sentinel(
            &recovered,
            "new-data",
            Some("new-generation-must-not-be-deleted"),
        );
        gateway.assert_sentinel(&recovered, "old-data", preserve.then_some("old-generation"));
        assert_eq!(gateway.scoped("container", Some(&id)).len(), 1);
        assert_eq!(gateway.scoped("volume", Some(&id)).len(), 1);
        // 再次强制重启验证已经提交就绪的资源也能重新对账。
        gateway.kill();
        gateway.start(true).await;
        sandbox = gateway.settled(&id, "running").await;
        assert_eq!(gateway.inspect(&sandbox)["Id"], new_container["Id"]);
        gateway.assert_sentinel(
            &sandbox,
            "new-data",
            Some("new-generation-must-not-be-deleted"),
        );
    }
    gateway.delete(&id).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires Docker"]
async fn docker_delete_failure_survives_gateway_restart() {
    let mut gateway = Gateway::new();
    gateway.start(false).await;
    let created = gateway.create().await;
    let id = created["id"].as_str().unwrap().to_owned();
    let sandbox = gateway.settled(&id, "running").await;
    let volume = format!(
        "{}-{}-v{}",
        gateway.scope, id, sandbox["resource"]["data_generation"]
    );
    let holder = format!("{}-volume-holder", gateway.scope);
    // 此容器只属于验收脚本，用来模拟卷暂时被外部占用。
    docker(&[
        "run",
        "-d",
        "--name",
        &holder,
        "--label",
        &format!("io.ursi.scope={}", gateway.scope),
        "--mount",
        &format!("type=volume,src={volume},dst=/data"),
        "alpine:3.22",
        "sleep",
        "300",
    ]);
    let deadline = Instant::now() + WAIT;
    loop {
        let response = gateway
            .client
            .delete(format!("{}/api/v1/sandboxes/{id}", gateway.base))
            .bearer_auth(&gateway.key)
            .send()
            .await
            .unwrap();
        if response.status().as_u16() == 409 && Instant::now() < deadline {
            sleep(POLL).await;
            continue;
        }
        assert_eq!(response.status().as_u16(), 202);
        break;
    }
    loop {
        let current = gateway.get(&id).await;
        if current["error"].is_string() {
            assert_eq!(current["operation"]["kind"], "delete");
            assert_eq!(current["status"], "deleting");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "delete never reached blocked volume"
        );
        sleep(POLL).await;
    }
    assert!(
        docker_output(&["volume", "inspect", &volume])
            .status
            .success()
    );
    gateway.kill();
    docker(&["rm", "-f", &holder]);
    gateway.start(false).await;
    let deadline = Instant::now() + WAIT;
    loop {
        let response = gateway
            .client
            .get(format!("{}/api/v1/sandboxes/{id}", gateway.base))
            .bearer_auth(&gateway.key)
            .send()
            .await
            .unwrap();
        if response.status().as_u16() == 404 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "persisted delete did not converge"
        );
        sleep(POLL).await;
    }
    assert!(gateway.scoped("container", Some(&id)).is_empty());
    assert!(gateway.scoped("volume", Some(&id)).is_empty());
}
