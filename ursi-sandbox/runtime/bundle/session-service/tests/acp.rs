use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};
use tempfile::TempDir;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
const TOKEN: &str = "fake-session-token-012345678901234567890123";
struct Server {
    temp: TempDir,
    child: Option<Child>,
    port: u16,
}
impl Server {
    async fn new(timeout: u64) -> Self {
        let temp = tempfile::tempdir().unwrap();
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755)).unwrap();
        for dir in ["config/pi", "workspace/repo", "workspace/other", "outside"] {
            fs::create_dir_all(temp.path().join(dir)).unwrap();
        }
        for dir in ["workspace", "workspace/repo", "workspace/other"] {
            fs::set_permissions(temp.path().join(dir), fs::Permissions::from_mode(0o777)).unwrap();
        }
        fs::set_permissions(
            temp.path().join("config"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        fs::write(temp.path().join("config/session-token"), TOKEN).unwrap();
        fs::write(
            temp.path().join("config/session.json"),
            r#"{"provider":"fake","model":"fake-model"}"#,
        )
        .unwrap();
        fs::write(temp.path().join("config/pi/models.json"), "{}").unwrap();
        fs::write(
            temp.path().join("config/pi/auth.json"),
            r#"{"fake":{"type":"api_key","key":"FAKE_MODEL_KEY"}}"#,
        )
        .unwrap();
        let fake = temp.path().join("fake-pi");
        fs::write(&fake, include_str!("fake_pi.py")).unwrap();
        fs::set_permissions(fake, fs::Permissions::from_mode(0o755)).unwrap();
        let listener = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut server = Self {
            temp,
            child: None,
            port,
        };
        server.start(timeout).await;
        server
    }
    fn path(&self, path: &str) -> PathBuf {
        self.temp.path().join(path)
    }
    async fn start(&mut self, timeout: u64) {
        let log = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(self.path("service.log"))
            .unwrap();
        self.child = Some(
            Command::new(env!("CARGO_BIN_EXE_ursi-session-service"))
                .env("URSI_SESSION_CONFIG_DIR", self.path("config"))
                .env("URSI_WORKSPACE_ROOT", self.path("workspace"))
                .env("URSI_SESSION_STATE_DIR", self.path("workspace/.ursi-state"))
                .env("URSI_SESSION_RUNTIME_DIR", self.path("runtime"))
                .env("URSI_PI_BIN", self.path("fake-pi"))
                .env("URSI_SESSION_BIND", format!("0.0.0.0:{}", self.port))
                .env("URSI_SESSION_TASK_TIMEOUT_SECS", timeout.to_string())
                .env("URSI_SESSION_TOKEN", "INHERITED_TOKEN_MUST_NOT_REACH_PI")
                .env("HOST_SECRET", "INHERITED_SECRET_MUST_NOT_REACH_PI")
                .env("NODE_OPTIONS", "MUST_NOT_REACH_PI")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(log)
                .spawn()
                .unwrap(),
        );
        let client = reqwest::Client::new();
        for _ in 0..200 {
            if client
                .get(format!("http://127.0.0.1:{}/healthz", self.port))
                .send()
                .await
                .is_ok()
            {
                return;
            }
            if self.child.as_mut().unwrap().try_wait().unwrap().is_some() {
                panic!(
                    "service failed: {}",
                    fs::read_to_string(self.path("service.log")).unwrap()
                );
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("service not ready");
    }
    async fn socket(&self) -> Socket {
        let mut request = format!("ws://127.0.0.1:{}/acp", self.port)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Authorization", format!("Bearer {TOKEN}").parse().unwrap());
        connect_async(request).await.unwrap().0
    }
    async fn connect(&self) -> Socket {
        let mut socket = self.socket().await;
        send(&mut socket, json!({"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}})).await;
        assert_eq!(
            reply(&mut socket, json!("init")).await["result"]["protocolVersion"],
            1
        );
        socket
    }
    async fn session(&self, socket: &mut Socket, folder: &str) -> String {
        send(socket, json!({"jsonrpc":"2.0","id":"new","method":"session/new","params":{"cwd":self.path(folder),"mcpServers":[]}})).await;
        reply(socket, json!("new")).await["result"]["sessionId"]
            .as_str()
            .unwrap()
            .to_string()
    }
    fn kill(&mut self) {
        if let Some(mut child) = self.child.take() {
            child.kill().unwrap();
            child.wait().unwrap();
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.kill();
    }
}
async fn send(socket: &mut Socket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
async fn next(socket: &mut Socket) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Message::Text(text) = socket.next().await.unwrap().unwrap() {
                return serde_json::from_str(&text).unwrap();
            }
        }
    })
    .await
    .expect("response deadline")
}
async fn reply(socket: &mut Socket, id: Value) -> Value {
    loop {
        let value = next(socket).await;
        if value.get("id") == Some(&id) {
            return value;
        }
    }
}
async fn prompt(socket: &mut Socket, session: &str, id: Value, text: &str) {
    send(socket, json!({"jsonrpc":"2.0","id":id,"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":text}]}})).await;
}
async fn status(socket: &mut Socket, session: &str) -> Value {
    send(socket, json!({"jsonrpc":"2.0","id":"status","method":"_ursi/session/status","params":{"sessionId":session}})).await;
    reply(socket, json!("status")).await["result"].clone()
}
async fn file_ready(path: PathBuf) -> String {
    for _ in 0..300 {
        if let Ok(text) = fs::read_to_string(&path) {
            if !text.is_empty() {
                return text;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("file not created: {}", path.display());
}
async fn gone(pid: i32) {
    for _ in 0..300 {
        if !PathBuf::from(format!("/proc/{pid}")).exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("process survived: {pid}");
}

// 单独的测试进程作 subreaper，避免异常 supervisor 留下的证据进程污染主机。
// 只收割测试明确登记的 PID，不扫描或杀死其他会话。
struct Orphans(Vec<(i32, std::os::fd::OwnedFd)>);
impl Orphans {
    fn track(&mut self, pid: i32) {
        use std::os::fd::FromRawFd;
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) as i32 };
        assert!(fd >= 0);
        self.0
            .push((pid, unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) }));
    }
}
impl Drop for Orphans {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        for (_, fd) in self.0.iter().rev() {
            unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd.as_raw_fd(),
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                );
            }
        }
        for (pid, _) in self.0.iter().rev() {
            // service/supervisor 已退出后，登记的孤儿归本测试进程。
            for _ in 0..300 {
                let result = unsafe { libc::waitpid(*pid, std::ptr::null_mut(), libc::WNOHANG) };
                if result == *pid || !PathBuf::from(format!("/proc/{pid}")).exists() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

#[tokio::test]
async fn supervisor_sigkill_never_claims_cleanup_and_preserves_other_sessions() {
    if std::env::var_os("URSI_TEST_ORPHAN_REAPER").is_none() {
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "supervisor_sigkill_never_claims_cleanup_and_preserves_other_sessions",
                "--nocapture",
            ])
            .env("URSI_TEST_ORPHAN_REAPER", "1")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    assert_eq!(unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1) }, 0);
    // 覆盖取消中、运行中（stdout 仍打开）、idle 的异常退出。
    for mode in ["cancel", "running", "idle"] {
        let mut orphans = Orphans(Vec::new());
        let mut server = Server::new(60).await;
        let mut socket = server.connect().await;
        let one = server.session(&mut socket, "workspace/repo").await;
        let two = server.session(&mut socket, "workspace/other").await;
        prompt(&mut socket, &two, json!("other"), "normal").await;
        assert_eq!(
            reply(&mut socket, json!("other")).await["result"]["stopReason"],
            "end_turn"
        );
        let other_pid = status(&mut socket, &two).await["pid"].clone();
        prompt(
            &mut socket,
            &one,
            json!("run"),
            if mode == "idle" { "normal" } else { "detached" },
        )
        .await;
        let pi: Value =
            serde_json::from_str(&file_ready(server.path("workspace/repo/identity.json")).await)
                .unwrap();
        orphans.track(pi["pid"].as_i64().unwrap() as i32);
        let mut tools = Vec::new();
        if mode == "idle" {
            assert_eq!(
                reply(&mut socket, json!("run")).await["result"]["stopReason"],
                "end_turn"
            );
        } else {
            for file in ["tool.pid", "grandchild.pid"] {
                let pid = file_ready(server.path(&format!("workspace/repo/{file}")))
                    .await
                    .parse::<i32>()
                    .unwrap();
                orphans.track(pid);
                tools.push(pid);
            }
        }
        let supervisor = status(&mut socket, &one).await["pid"].as_i64().unwrap() as i32;
        if mode == "cancel" {
            // 暂停监督器，确定协作阶段即使延迟也不会先完成回收。
            assert_eq!(unsafe { libc::kill(supervisor, libc::SIGSTOP) }, 0);
            send(
                &mut socket,
                json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":one}}),
            )
            .await;
            // 证明取消已进入协作阶段，再从测试进程杀 supervisor。
            file_ready(server.path("workspace/repo/cancellation.log")).await;
        }
        assert_eq!(unsafe { libc::kill(supervisor, libc::SIGKILL) }, 0);
        if mode != "idle" {
            let response =
                tokio::time::timeout(Duration::from_secs(3), reply(&mut socket, json!("run")))
                    .await
                    .unwrap();
            assert_eq!(response["error"]["message"], "process cleanup failed");
            assert!(response.get("result").is_none());
        }
        // SIGKILL 投递与 wait 状态可见之间存在调度间隙。
        let state = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let state = status(&mut socket, &one).await;
                if state["state"] == "interrupted" {
                    break state;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(state["state"], "interrupted");
        assert_eq!(state["pid"], Value::Null);
        for pid in &tools {
            let stat = fs::read_to_string(format!("/proc/{pid}/stat"))
                .expect("测试必须保留未清理后代的证据");
            assert_ne!(
                stat.rsplit_once(") ").unwrap().1.split_whitespace().next(),
                Some("Z")
            );
        }
        for _ in 0..2 {
            send(&mut socket, json!({"jsonrpc":"2.0","id":"close","method":"_ursi/session/close","params":{"sessionId":one}})).await;
            assert_eq!(
                reply(&mut socket, json!("close")).await["error"]["message"],
                "process cleanup failed"
            );
            assert_eq!(status(&mut socket, &one).await["state"], "interrupted");
        }
        prompt(&mut socket, &two, json!("still-alive"), "normal").await;
        assert_eq!(
            reply(&mut socket, json!("still-alive")).await["result"]["stopReason"],
            "end_turn"
        );
        assert_eq!(status(&mut socket, &two).await["pid"], other_pid);
        send(&mut socket, json!({"jsonrpc":"2.0","id":"close-other","method":"_ursi/session/close","params":{"sessionId":two}})).await;
        assert_eq!(
            reply(&mut socket, json!("close-other")).await["result"],
            json!({})
        );
        server.kill();
        server.start(60).await;
        let mut socket = server.connect().await;
        send(&mut socket, json!({"jsonrpc":"2.0","id":"close-after-restart","method":"_ursi/session/close","params":{"sessionId":one}})).await;
        assert_eq!(
            reply(&mut socket, json!("close-after-restart")).await["error"]["message"],
            "process cleanup failed"
        );
        server.kill();
        drop(orphans);
        for pid in tools {
            gone(pid).await;
        }
    }
}

#[tokio::test]
async fn pinned_cwd_spawn_and_missing_cleanup_receipt() {
    use std::os::unix::fs::MetadataExt;
    use ursi_agent_cli_adapter::{Error, PiProcess, SpawnSpec};
    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("repo");
    let moved = temp.path().join("moved");
    let outside = temp.path().join("outside");
    fs::create_dir(&original).unwrap();
    fs::create_dir(&outside).unwrap();
    let directory = fs::File::open(&original).unwrap();
    let identity = directory.metadata().unwrap();
    // 在获取句柄与启动之间替换路径，启动只允许使用已固定的目录对象。
    fs::rename(&original, &moved).unwrap();
    symlink(&outside, &original).unwrap();
    let fake = temp.path().join("supervisor");
    fs::write(
        &fake,
        r#"#!/usr/bin/python3
import json, os, signal, sys
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM})
stat = os.stat('.')
print(json.dumps(dict(cwd=os.getcwd(), dev=stat.st_dev, ino=stat.st_ino)), flush=True)
# 故意正常退出却不发送清理回执。
for line in sys.stdin:
    pass
"#,
    )
    .unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    let spec = SpawnSpec {
        bin: fake.clone(),
        runtime_dir: temp.path().into(),
        provider: "fake".into(),
        model: "fake".into(),
    };
    let mut process = PiProcess::spawn(spec, &fake, -1, &directory).unwrap();
    let event = tokio::time::timeout(Duration::from_secs(3), process.next())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event["cwd"], moved.to_str().unwrap());
    assert_eq!(event["dev"], identity.dev());
    assert_eq!(event["ino"], identity.ino());
    assert!(matches!(
        process.stop(false).await,
        Err(Error::CleanupUnconfirmed)
    ));
    assert_eq!(process.pid(), None);
}

#[tokio::test]
async fn cwd_replacement_rejects_first_and_reused_turns() {
    for started in [false, true] {
        for replacement in ["outside", "inside", "directory", "request-alias"] {
            let server = Server::new(10).await;
            let mut socket = server.connect().await;
            let requested = if replacement == "request-alias" {
                symlink(
                    server.path("workspace/repo"),
                    server.path("workspace/alias"),
                )
                .unwrap();
                "workspace/alias"
            } else {
                "workspace/repo"
            };
            let session = server.session(&mut socket, requested).await;
            let mut previous = None;
            if started {
                prompt(&mut socket, &session, json!("first"), "normal").await;
                assert_eq!(
                    reply(&mut socket, json!("first")).await["result"]["stopReason"],
                    "end_turn"
                );
                previous = status(&mut socket, &session).await["pid"].as_i64();
            }
            if replacement == "request-alias" {
                fs::remove_file(server.path("workspace/alias")).unwrap();
                symlink(server.path("outside"), server.path("workspace/alias")).unwrap();
            } else {
                fs::rename(
                    server.path("workspace/repo"),
                    server.path("workspace/moved"),
                )
                .unwrap();
                match replacement {
                    "outside" => {
                        symlink(server.path("outside"), server.path("workspace/repo")).unwrap()
                    }
                    "inside" => symlink(
                        server.path("workspace/other"),
                        server.path("workspace/repo"),
                    )
                    .unwrap(),
                    _ => fs::create_dir(server.path("workspace/repo")).unwrap(),
                }
            }
            prompt(&mut socket, &session, json!("tampered"), "normal").await;
            assert_eq!(
                reply(&mut socket, json!("tampered")).await["error"]["code"],
                -32602,
                "{started} {replacement}"
            );
            let state = status(&mut socket, &session).await;
            assert_eq!(state["state"], "interrupted");
            assert_eq!(state["pid"], Value::Null);
            if let Some(pid) = previous {
                gone(pid as i32).await;
            }
            for path in ["outside/prompts.count", "workspace/other/prompts.count"] {
                assert!(!server.path(path).exists());
            }
            let old_path = if replacement == "request-alias" {
                "workspace/repo/prompts.count"
            } else {
                "workspace/moved/prompts.count"
            };
            if started {
                assert_eq!(fs::read_to_string(server.path(old_path)).unwrap(), "1");
            } else {
                assert!(!server.path(old_path).exists());
            }
            assert!(!server.path("runtime").join(&session).exists());
        }
    }
}

#[tokio::test]
async fn authentication_validation_and_workspace_boundaries() {
    let server = Server::new(10).await;
    for (suffix, auth, origin, expected) in [
        ("", false, false, 401),
        ("?token=bad", true, false, 403),
        ("", true, true, 403),
    ] {
        let mut request = format!("ws://127.0.0.1:{}/acp{suffix}", server.port)
            .into_client_request()
            .unwrap();
        if auth {
            request
                .headers_mut()
                .insert("Authorization", format!("Bearer {TOKEN}").parse().unwrap());
        }
        if origin {
            request
                .headers_mut()
                .insert("Origin", "https://evil.invalid".parse().unwrap());
        }
        let error = connect_async(request).await.unwrap_err();
        match error {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                assert_eq!(response.status().as_u16(), expected)
            }
            other => panic!("{other}"),
        }
    }
    let mut socket = server.socket().await;
    send(
        &mut socket,
        json!({"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}),
    )
    .await;
    assert_eq!(reply(&mut socket, json!(1)).await["error"]["code"], -32000);
    send(&mut socket, json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":2,"clientCapabilities":{}}})).await;
    assert_eq!(reply(&mut socket, json!(2)).await["error"]["code"], -32602);
    drop(socket);
    let mut socket = server.connect().await;
    symlink(server.path("outside"), server.path("workspace/escape")).unwrap();
    symlink(
        server.path("workspace/.ursi-state"),
        server.path("workspace/state-link"),
    )
    .unwrap();
    for cwd in [
        server.path("outside"),
        server.path("workspace/escape"),
        server.path("workspace/.ursi-state"),
        server.path("workspace/state-link"),
        PathBuf::from("relative"),
    ] {
        send(&mut socket, json!({"jsonrpc":"2.0","id":"bad","method":"session/new","params":{"cwd":cwd,"mcpServers":[]}})).await;
        assert_eq!(
            reply(&mut socket, json!("bad")).await["error"]["code"],
            -32602
        );
    }
    for (method, params, code) in [
        (
            "session/new",
            json!({"cwd":server.path("workspace/repo"),"mcpServers":[{}]}),
            -32602,
        ),
        ("unknown", json!({}), -32601),
    ] {
        send(
            &mut socket,
            json!({"jsonrpc":"2.0","id":10,"method":method,"params":params}),
        )
        .await;
        assert_eq!(reply(&mut socket, json!(10)).await["error"]["code"], code);
    }
    socket.send(Message::Text("{".into())).await.unwrap();
    assert_eq!(next(&mut socket).await["error"]["code"], -32700);
}

#[tokio::test]
async fn event_order_completion_error_and_long_lived_pi() {
    let server = Server::new(10).await;
    let mut socket = server.connect().await;
    let session = server.session(&mut socket, "workspace/repo").await;
    prompt(&mut socket, &session, json!(42), "delay").await;
    let mut updates = Vec::new();
    for _ in 0..4 {
        let event = next(&mut socket).await;
        assert_eq!(event["params"]["sessionId"], session);
        updates.push(event["params"]["update"].clone());
    }
    assert_eq!(
        updates[0]["content"]["text"],
        "hello\u{2028}world\u{2029}turn=1"
    );
    assert_eq!(updates[1]["sessionUpdate"], "tool_call");
    assert_eq!(updates[2]["status"], "in_progress");
    assert_eq!(updates[3]["status"], "completed");
    assert!(
        tokio::time::timeout(Duration::from_millis(80), socket.next())
            .await
            .is_err()
    );
    prompt(&mut socket, &session, json!(43), "normal").await;
    assert_eq!(reply(&mut socket, json!(43)).await["error"]["code"], -32000);
    assert_eq!(status(&mut socket, &session).await["state"], "running");
    assert_eq!(
        reply(&mut socket, json!(42)).await["result"]["stopReason"],
        "end_turn"
    );
    let pid = status(&mut socket, &session).await["pid"].as_i64().unwrap();
    prompt(&mut socket, &session, json!(44), "normal").await;
    assert_eq!(
        next(&mut socket).await["params"]["update"]["content"]["text"],
        "hello\u{2028}world\u{2029}turn=2"
    );
    assert_eq!(
        reply(&mut socket, json!(44)).await["result"]["stopReason"],
        "end_turn"
    );
    assert_eq!(status(&mut socket, &session).await["pid"], pid);
    prompt(&mut socket, &session, json!(45), "error").await;
    let failure = reply(&mut socket, json!(45)).await;
    assert_eq!(failure["error"]["code"], -32000);
    assert!(!failure.to_string().contains("MODEL_SECRET"));
    assert_eq!(status(&mut socket, &session).await["state"], "interrupted");
    assert_eq!(status(&mut socket, &session).await["pid"], Value::Null);
    gone(pid as i32).await;
    assert!(
        !fs::read_to_string(server.path("service.log"))
            .unwrap()
            .contains("MODEL_SECRET")
    );
}

#[tokio::test]
async fn cancellation_reaps_detached_descendants_and_isolates_sessions() {
    let server = Server::new(10).await;
    let mut socket = server.connect().await;
    let one = server.session(&mut socket, "workspace/repo").await;
    let two = server.session(&mut socket, "workspace/other").await;
    prompt(&mut socket, &one, json!("hang"), "hang").await;
    let tool = file_ready(server.path("workspace/repo/tool.pid"))
        .await
        .parse::<i32>()
        .unwrap();
    let grandchild = file_ready(server.path("workspace/repo/grandchild.pid"))
        .await
        .parse::<i32>()
        .unwrap();
    let pi: Value =
        serde_json::from_str(&file_ready(server.path("workspace/repo/identity.json")).await)
            .unwrap();
    assert_ne!(pi["uid"], 0);
    if unsafe { libc::geteuid() } == 0 {
        assert_eq!(pi["uid"], 1000);
        assert_eq!(pi["gid"], 1000);
    }
    send(
        &mut socket,
        json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":one}}),
    )
    .await;
    assert_eq!(
        reply(&mut socket, json!("hang")).await["result"]["stopReason"],
        "cancelled"
    );
    for pid in [tool, grandchild, pi["pid"].as_i64().unwrap() as i32] {
        assert!(
            !PathBuf::from(format!("/proc/{pid}")).exists(),
            "cancelled response preceded cleanup"
        );
    }
    assert_eq!(
        file_ready(server.path("workspace/repo/cancellation.log")).await,
        "clear_queue\nabort\n"
    );
    assert_eq!(status(&mut socket, &one).await["state"], "cancelled");
    assert_eq!(status(&mut socket, &one).await["pid"], Value::Null);
    prompt(&mut socket, &two, json!("other"), "normal").await;
    assert_eq!(
        reply(&mut socket, json!("other")).await["result"]["stopReason"],
        "end_turn"
    );
    send(&mut socket, json!({"jsonrpc":"2.0","id":"close","method":"_ursi/session/close","params":{"sessionId":two}})).await;
    assert_eq!(
        reply(&mut socket, json!("close")).await["result"],
        json!({})
    );
    assert_eq!(status(&mut socket, &two).await["state"], "closed");
    assert_eq!(fs::read_dir(server.path("runtime")).unwrap().count(), 0);
}

#[tokio::test]
async fn disconnect_and_restart_never_replay() {
    let mut server = Server::new(10).await;
    let mut socket = server.connect().await;
    let session = server.session(&mut socket, "workspace/repo").await;
    prompt(&mut socket, &session, json!("run"), "hang").await;
    let tool = file_ready(server.path("workspace/repo/tool.pid"))
        .await
        .parse::<i32>()
        .unwrap();
    let grandchild = file_ready(server.path("workspace/repo/grandchild.pid"))
        .await
        .parse::<i32>()
        .unwrap();
    drop(socket);
    let mut socket = server.connect().await;
    assert_eq!(status(&mut socket, &session).await["state"], "running");
    assert!(PathBuf::from(format!("/proc/{tool}")).exists());
    server.kill();
    gone(tool).await;
    gone(grandchild).await;
    // 等待 supervisor 退出并释放锁，无重放。
    for _ in 0..200 {
        let file = fs::File::open(server.path("workspace/.ursi-state/service.lock")).unwrap();
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    server.start(10).await;
    let mut socket = server.connect().await;
    let current = status(&mut socket, &session).await;
    assert_eq!(current["state"], "interrupted");
    assert_eq!(current["pid"], Value::Null);
    assert_eq!(
        file_ready(server.path("workspace/repo/prompts.count")).await,
        "1"
    );
    prompt(&mut socket, &session, json!("retry"), "normal").await;
    assert_eq!(
        reply(&mut socket, json!("retry")).await["error"]["code"],
        -32000
    );
}

#[tokio::test]
async fn malformed_exit_oversize_and_deadline_are_errors() {
    let server = Server::new(1).await;
    let mut socket = server.connect().await;
    for text in ["malformed", "crash", "huge", "hang"] {
        let session = server.session(&mut socket, "workspace/repo").await;
        prompt(&mut socket, &session, json!(text), text).await;
        assert_eq!(
            reply(&mut socket, json!(text)).await["error"]["code"],
            -32000,
            "{text}"
        );
        assert_eq!(status(&mut socket, &session).await["pid"], Value::Null);
    }
    let grandchild = file_ready(server.path("workspace/repo/grandchild.pid"))
        .await
        .parse::<i32>()
        .unwrap();
    assert!(!PathBuf::from(format!("/proc/{grandchild}")).exists());
}

#[tokio::test]
async fn slow_consumer_does_not_block_reconnected_cancel() {
    let server = Server::new(10).await;
    let mut slow = server.connect().await;
    let session = server.session(&mut slow, "workspace/repo").await;
    prompt(&mut slow, &session, json!("flood"), "flood").await;
    let pid = file_ready(server.path("workspace/repo/grandchild.pid"))
        .await
        .parse::<i32>()
        .unwrap();
    // slow 保持连接且停止读消息，从第二个连接取消。
    tokio::time::sleep(Duration::from_millis(150)).await;
    let mut control = server.connect().await;
    send(
        &mut control,
        json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}}),
    )
    .await;
    for _ in 0..100 {
        let value = status(&mut control, &session).await;
        if value["state"] == "cancelled" {
            assert_eq!(value["pid"], Value::Null);
            assert!(!PathBuf::from(format!("/proc/{pid}")).exists());
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("cancel blocked by event backpressure");
}

#[tokio::test]
async fn closing_running_session_is_nonblocking_and_reaps_before_reply() {
    let server = Server::new(10).await;
    let mut socket = server.connect().await;
    let session = server.session(&mut socket, "workspace/repo").await;
    prompt(&mut socket, &session, json!("prompt"), "hang").await;
    let pid = file_ready(server.path("workspace/repo/grandchild.pid"))
        .await
        .parse::<i32>()
        .unwrap();
    for id in ["close-one", "close-two"] {
        send(&mut socket, json!({"jsonrpc":"2.0","id":id,"method":"_ursi/session/close","params":{"sessionId":session}})).await;
    }
    let mut replies = std::collections::HashSet::new();
    while replies.len() < 3 {
        let value = next(&mut socket).await;
        if let Some(id) = value["id"].as_str() {
            if id == "prompt" {
                assert_eq!(value["result"]["stopReason"], "cancelled");
            } else {
                assert_eq!(value["result"], json!({}));
            }
            assert!(!PathBuf::from(format!("/proc/{pid}")).exists());
            replies.insert(id.to_string());
        }
    }
    assert_eq!(status(&mut socket, &session).await["state"], "closed");
}

#[tokio::test]
async fn immediate_cancel_cleans_startup_and_runtime() {
    let server = Server::new(10).await;
    let mut socket = server.connect().await;
    for _ in 0..20 {
        let session = server.session(&mut socket, "workspace/repo").await;
        prompt(&mut socket, &session, json!("run"), "hang").await;
        send(
            &mut socket,
            json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}}),
        )
        .await;
        assert_eq!(
            reply(&mut socket, json!("run")).await["result"]["stopReason"],
            "cancelled"
        );
        assert!(!server.path("runtime").join(&session).exists());
        assert_eq!(status(&mut socket, &session).await["pid"], Value::Null);
        for entry in fs::read_dir("/proc").unwrap().flatten() {
            if let Ok(command) = fs::read(entry.path().join("cmdline")) {
                assert!(
                    !String::from_utf8_lossy(&command).contains(&session),
                    "supervisor survived cancelled response"
                );
            }
        }
    }
}

#[tokio::test]
async fn capacity_and_websocket_message_limits() {
    let server = Server::new(10).await;
    let mut socket = server.connect().await;
    let first = server.session(&mut socket, "workspace/repo").await;
    for _ in 1..64 {
        server.session(&mut socket, "workspace/repo").await;
    }
    send(&mut socket, json!({"jsonrpc":"2.0","id":"limit","method":"session/new","params":{"cwd":server.path("workspace/repo"),"mcpServers":[]}})).await;
    assert_eq!(
        reply(&mut socket, json!("limit")).await["error"]["code"],
        -32000
    );
    send(&mut socket, json!({"jsonrpc":"2.0","id":"close","method":"_ursi/session/close","params":{"sessionId":first}})).await;
    assert_eq!(
        reply(&mut socket, json!("close")).await["result"],
        json!({})
    );
    server.session(&mut socket, "workspace/repo").await;
    // 服务可仅凭帧头判定超限并关闭，此时发送端本身就可能收到 BrokenPipe。
    if socket
        .send(Message::Text("x".repeat(1024 * 1024 + 1).into()))
        .await
        .is_ok()
    {
        let result = tokio::time::timeout(Duration::from_secs(3), socket.next())
            .await
            .unwrap();
        assert!(!matches!(result, Some(Ok(Message::Text(_)))));
    }
}

#[tokio::test]
async fn graceful_restart_marks_unfinished_execution_interrupted() {
    let mut server = Server::new(10).await;
    let mut socket = server.connect().await;
    let session = server.session(&mut socket, "workspace/repo").await;
    prompt(&mut socket, &session, json!("run"), "hang").await;
    let pid = file_ready(server.path("workspace/repo/grandchild.pid"))
        .await
        .parse::<i32>()
        .unwrap();
    unsafe {
        libc::kill(server.child.as_ref().unwrap().id() as i32, libc::SIGTERM);
    }
    for _ in 0..300 {
        if server.child.as_mut().unwrap().try_wait().unwrap().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        server.child.as_mut().unwrap().try_wait().unwrap().is_some(),
        "graceful shutdown hung"
    );
    server.child = None;
    assert!(!PathBuf::from(format!("/proc/{pid}")).exists());
    server.start(10).await;
    let mut socket = server.connect().await;
    assert_eq!(status(&mut socket, &session).await["state"], "interrupted");
}
