//! 基于 `ursi-sandbox-client` 公共 Rust 接口的 Runtime ACP WebSocket 接入。
//!
//! 这里使用真实 WebSocket/JSON-RPC，不复用 `AcpFrameTransport` 的长度帧。
//! 每个操作建立独立连接并先 initialize；断线或超时只报告未知结果，不重放
//! prompt。Runtime 负责模型与工作区配置，Flow 只发送 Runtime ACP 子集允许
//! 的 cwd、空 MCP 列表和文本 prompt。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use ursi_domain::{EventCategory, ExecutionEnv, Executor, Role};
use ursi_sandbox_client::{Acp, Error as ClientError, PromptOutcome, Secret};

use crate::capability::{CapabilityConfig, CapabilityError};
use crate::session::{
    AcpEvent, ExecutionState, SessionControl, SessionError, SessionHandle, SessionSpec,
    map_acp_event_to_telemetry,
};
use crate::{EventSink, ExecutorError, InvocationInput, InvocationResult, Runner};

/// 真实 Runtime ACP 连接配置。
///
/// 配置不实现 Debug，调用方不应把 session token 写入日志。Runtime 的
/// session.json/model 配置在沙箱管理员 profile 中管理，不经 ACP session/new
/// 传入。
pub struct WebSocketAcpConfig {
    pub url: String,
    pub session_token: String,
    pub timeout: Duration,
}

/// 使用真实 ACP WebSocket 的会话控制器。
///
/// 控制器不持有长连接。create/prompt/cancel/close/status 各自建立连接，
/// 因而 prompt 在途时可以由另一个连接发送 cancel，符合 Runtime 契约。
pub struct WebSocketSessionController {
    config: WebSocketAcpConfig,
    sessions: Mutex<HashMap<String, TrackedSession>>,
}

struct TrackedSession {
    role_prompt: String,
    // None：prompt 正在执行，或未收到可以安全发起下一轮的响应。
    state: Option<ExecutionState>,
}

impl WebSocketSessionController {
    pub fn new(config: WebSocketAcpConfig) -> Result<Self, SessionError> {
        validate_token(&config.session_token)
            .map_err(|_| SessionError::SessionSetup("session token 配置无效".into()))?;
        if !valid_acp_url(&config.url) {
            return Err(SessionError::SessionSetup(
                "URSI_ACP_URL 必须是有效的 WebSocket 地址，且不能含凭据、query 或 fragment".into(),
            ));
        }
        if config.timeout.is_zero() {
            return Err(SessionError::SessionSetup("ACP 超时必须大于 0".into()));
        }
        Ok(Self {
            config,
            sessions: Mutex::new(HashMap::new()),
        })
    }

    async fn connect(&self) -> Result<Acp, SessionError> {
        let token = Secret::new(self.config.session_token.clone())
            .map_err(|_| SessionError::SessionSetup("session token 配置无效".into()))?;
        let mut acp = Acp::connect(&self.config.url, token, self.config.timeout)
            .await
            .map_err(map_setup_error)?;
        acp.initialize().await.map_err(map_setup_error)?;
        Ok(acp)
    }

    fn reject_runtime_unsupported(capability: &CapabilityConfig) -> Result<(), SessionError> {
        if !matches!(
            capability.model.as_deref(),
            None | Some(crate::RUNTIME_PROFILE)
        ) {
            return Err(SessionError::UnsupportedCapability(
                CapabilityError::Unsupported(
                    "Runtime ACP 的 model 只能省略或指定 runtime-profile".into(),
                ),
            ));
        }
        if !capability.skills.is_empty() {
            return Err(SessionError::UnsupportedCapability(
                CapabilityError::Unsupported(
                    "Runtime ACP 子集不接受 Flow skills；请将技能装入 Runtime bundle".into(),
                ),
            ));
        }
        if !capability.mcp_servers.is_empty() {
            return Err(SessionError::UnsupportedCapability(
                CapabilityError::Unsupported("Runtime ACP 子集只接受空 mcpServers".into()),
            ));
        }
        Ok(())
    }

    /// 查询 Runtime 的会话状态，不把断线当作已结束。
    pub async fn status(&self, session: &SessionHandle) -> Result<Value, SessionError> {
        let mut acp = self.connect().await?;
        acp.request(
            "_ursi/session/status",
            json!({"sessionId": session.session_id}),
            |_| {},
        )
        .await
        .map_err(map_request_error)
    }

    async fn open(&self, spec: &SessionSpec) -> Result<SessionHandle, SessionError> {
        Self::reject_runtime_unsupported(&spec.capability)?;
        let mut acp = self.connect().await?;
        let result = acp
            .request(
                "session/new",
                json!({"cwd":"/ursi/workspace/repo","mcpServers":[]}),
                |_| {},
            )
            .await
            .map_err(map_request_error)?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| SessionError::Protocol("session/new 响应缺少 sessionId".into()))?
            .to_string();
        Ok(SessionHandle {
            id: SessionHandle::local_id(&spec.run_id, &spec.node_id),
            session_id,
            run_id: spec.run_id.clone(),
            node_id: spec.node_id.clone(),
        })
    }

    async fn submit(
        acp: &mut Acp,
        role_prompt: &str,
        session: &SessionHandle,
        input: &InvocationInput,
        sink: EventSink<'_>,
    ) -> Result<(PromptOutcome, InvocationResult), SessionError> {
        let prompt = [role_prompt, &input.prompt, &input.artifact_context]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut output = String::new();
        let result = acp
            .request(
                "session/prompt",
                json!({
                    "sessionId": session.session_id,
                    "prompt": [{"type":"text","text":prompt}],
                }),
                |params| {
                    let msg = json!({
                        "jsonrpc":"2.0",
                        "method":"session/update",
                        "params":params,
                    });
                    let Some(event) = AcpEvent::parse(&msg) else {
                        return;
                    };
                    if event.session_id != session.session_id {
                        return;
                    }
                    let telemetry =
                        map_acp_event_to_telemetry(&event, &session.run_id, &session.node_id);
                    if telemetry.category == EventCategory::Node
                        && telemetry.name == "agent.message"
                    {
                        output.push_str(&telemetry.message);
                    }
                    sink(telemetry);
                },
            )
            .await
            .map_err(map_request_error)?;
        let outcome = PromptOutcome::from_result(&result)
            .map_err(|e| SessionError::Protocol(e.to_string()))?;
        Ok((
            outcome,
            InvocationResult {
                output,
                ..Default::default()
            },
        ))
    }

    async fn close_remote(&self, session: &SessionHandle) -> Result<(), SessionError> {
        let mut acp = self.connect().await?;
        let result = acp
            .request(
                "_ursi/session/close",
                json!({"sessionId": session.session_id}),
                |_| {},
            )
            .await
            .map_err(map_request_error)?;
        if !result.is_object() {
            return Err(SessionError::Protocol("session/close 响应不是对象".into()));
        }
        Ok(())
    }
}

#[async_trait]
impl SessionControl for WebSocketSessionController {
    async fn create_session(&self, spec: SessionSpec) -> Result<SessionHandle, SessionError> {
        let handle = self.open(&spec).await?;
        self.sessions.lock().unwrap().insert(
            handle.session_id.clone(),
            TrackedSession {
                role_prompt: spec.capability.prompt,
                state: Some(ExecutionState::Unknown),
            },
        );
        Ok(handle)
    }

    async fn prompt(
        &self,
        session: &SessionHandle,
        input: &InvocationInput,
        sink: EventSink<'_>,
    ) -> Result<InvocationResult, SessionError> {
        let mut acp = self.connect().await?;
        let role_prompt = {
            let mut sessions = self.sessions.lock().unwrap();
            let entry = sessions
                .get_mut(&session.session_id)
                .ok_or_else(|| SessionError::UnknownSession(session.session_id.clone()))?;
            if entry.state.take().is_none() {
                return Err(SessionError::Execution("上一轮 prompt 尚无确定结果".into()));
            }
            entry.role_prompt.clone()
        };
        let result = Self::submit(&mut acp, &role_prompt, session, input, sink).await;
        if let Some(entry) = self.sessions.lock().unwrap().get_mut(&session.session_id) {
            entry.state = match &result {
                Ok((PromptOutcome::Completed, _)) => Some(ExecutionState::Completed),
                Ok((PromptOutcome::Cancelled, _)) => Some(ExecutionState::Cancelled),
                Err(SessionError::Execution(_)) => Some(ExecutionState::Unknown),
                Err(_) => None,
            };
        }
        match result? {
            (PromptOutcome::Completed, result) => Ok(result),
            (PromptOutcome::Cancelled, _) => Err(SessionError::Execution("执行已取消".into())),
        }
    }

    async fn cancel(&self, session: &SessionHandle) -> Result<(), SessionError> {
        let mut acp = self.connect().await?;
        acp.notify("session/cancel", json!({"sessionId": session.session_id}))
            .await
            .map_err(map_request_error)
    }

    async fn close(&self, session: &SessionHandle) -> Result<ExecutionState, SessionError> {
        self.close_remote(session).await?;
        Ok(self
            .sessions
            .lock()
            .unwrap()
            .remove(&session.session_id)
            .and_then(|entry| entry.state)
            .unwrap_or(ExecutionState::Unknown))
    }
}

/// 将公开 ACP 会话控制器接入 Flow 的 Runner 契约。
pub struct AcpRunner {
    controller: WebSocketSessionController,
}

impl AcpRunner {
    pub fn new(config: WebSocketAcpConfig) -> Result<Self, ExecutorError> {
        let controller = WebSocketSessionController::new(config)
            .map_err(|e| ExecutorError::Launch(e.to_string()))?;
        Ok(Self { controller })
    }

    /// 从 Flow 的显式 opt-in 环境变量构造 Runner。
    ///
    /// `URSI_ACP_URL` 与 `URSI_SESSION_TOKEN(_FILE)` 必须成对出现；只设置
    /// 一侧、同时设置两种 token 来源或设置无效超时均明确拒绝。
    pub fn from_env() -> Result<Option<Self>, ExecutorError> {
        Self::from_vars(|name| std::env::var_os(name))
    }

    fn from_vars(
        get: impl Fn(&str) -> Option<std::ffi::OsString>,
    ) -> Result<Option<Self>, ExecutorError> {
        let optional = |name| {
            get(name)
                .map(|raw| {
                    raw.into_string()
                        .ok()
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| ExecutorError::Launch(format!("{name} 为空或不是 UTF-8")))
                })
                .transpose()
        };
        let url = optional("URSI_ACP_URL")?;
        let token = session_token(
            optional("URSI_SESSION_TOKEN")?,
            optional("URSI_SESSION_TOKEN_FILE")?,
        )?;
        let timeout = optional("URSI_CLIENT_TIMEOUT_SECS")?;
        if url.is_none() && token.is_none() {
            if timeout.is_some() {
                return Err(ExecutorError::Launch(
                    "URSI_CLIENT_TIMEOUT_SECS 仅能与 URSI_ACP_URL、URSI_SESSION_TOKEN 一起使用"
                        .into(),
                ));
            }
            return Ok(None);
        }
        let (Some(url), Some(session_token)) = (url, token) else {
            return Err(ExecutorError::Launch(
                "URSI_ACP_URL 与 URSI_SESSION_TOKEN 或 URSI_SESSION_TOKEN_FILE 必须同时设置".into(),
            ));
        };
        let timeout = parse_timeout(timeout.as_deref())?;
        Self::new(WebSocketAcpConfig {
            url,
            session_token,
            timeout,
        })
        .map(Some)
    }

    pub async fn status(&self, session: &SessionHandle) -> Result<Value, SessionError> {
        self.controller.status(session).await
    }
}

#[async_trait]
impl Runner for AcpRunner {
    async fn run(
        &self,
        input: &InvocationInput,
        role: &Role,
        executor: &Executor,
        _env: Arc<dyn ExecutionEnv>,
        sink: EventSink<'_>,
    ) -> Result<InvocationResult, ExecutorError> {
        if executor.kind.as_str() != crate::RUNTIME_ACP {
            return Err(ExecutorError::Launch(
                "ACP Runner 要求 executor.kind 为 runtime-acp".into(),
            ));
        }
        // 单次调用自己持有句柄，future 被丢弃时无需清理控制器的会话表。
        let handle = self
            .controller
            .open(&SessionSpec {
                run_id: input.run_id.clone(),
                node_id: input.node_id.clone(),
                capability: CapabilityConfig::from_role(role),
            })
            .await
            .map_err(map_runner_error)?;
        let mut acp = match self.controller.connect().await {
            Ok(acp) => acp,
            Err(error) => {
                let _ = self.controller.close_remote(&handle).await;
                return Err(map_runner_error(error));
            }
        };
        match WebSocketSessionController::submit(&mut acp, &role.prompt, &handle, input, sink).await
        {
            Ok((outcome, result)) => {
                self.controller
                    .close_remote(&handle)
                    .await
                    .map_err(|error| {
                        ExecutorError::DoNotRetry(format!(
                            "prompt 已结束，关闭会话 {} 失败：{error}",
                            handle.session_id
                        ))
                    })?;
                match outcome {
                    PromptOutcome::Completed => Ok(result),
                    PromptOutcome::Cancelled => Err(ExecutorError::DoNotRetry("执行已取消".into())),
                }
            }
            Err(error @ SessionError::Execution(_)) => {
                let _ = self.controller.close_remote(&handle).await;
                Err(map_runner_error(error))
            }
            Err(error) => Err(ExecutorError::DoNotRetry(format!(
                "会话 {} 的 prompt 结果未知：{error}",
                handle.session_id
            ))),
        }
    }
}

fn map_runner_error(error: SessionError) -> ExecutorError {
    match error {
        SessionError::UnsupportedCapability(error) => ExecutorError::Launch(error.to_string()),
        SessionError::SessionSetup(error) => ExecutorError::Launch(error),
        SessionError::ConnectionClosed => {
            ExecutorError::Execution("ACP 连接已断开，执行结果未知".into())
        }
        SessionError::Execution(error) | SessionError::UnknownSession(error) => {
            ExecutorError::Execution(error)
        }
        SessionError::Protocol(error) => ExecutorError::Parse(error),
    }
}

fn map_setup_error(error: ClientError) -> SessionError {
    match error {
        ClientError::Closed | ClientError::Timeout | ClientError::Transport => {
            SessionError::ConnectionClosed
        }
        ClientError::Rpc { message, .. } => SessionError::SessionSetup(message),
        ClientError::Invalid(message) | ClientError::Protocol(message) => {
            SessionError::Protocol(message)
        }
        ClientError::Gateway { .. } | ClientError::Io(_) => {
            SessionError::SessionSetup("ACP 连接初始化失败".into())
        }
    }
}

fn map_request_error(error: ClientError) -> SessionError {
    match error {
        ClientError::Closed | ClientError::Timeout | ClientError::Transport => {
            SessionError::ConnectionClosed
        }
        ClientError::Rpc { message, .. } => SessionError::Execution(message),
        ClientError::Invalid(message) | ClientError::Protocol(message) => {
            SessionError::Protocol(message)
        }
        ClientError::Gateway { .. } | ClientError::Io(_) => SessionError::ConnectionClosed,
    }
}

fn valid_acp_url(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|url| {
        matches!(url.scheme(), "ws" | "wss")
            && url.has_host()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

fn validate_token(token: &str) -> Result<(), ()> {
    if token.is_empty()
        || token
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err(());
    }
    Ok(())
}

fn session_token(
    value: Option<String>,
    file: Option<String>,
) -> Result<Option<String>, ExecutorError> {
    let name = "URSI_SESSION_TOKEN";
    match (value, file) {
        (Some(_), Some(_)) => Err(ExecutorError::Launch(format!(
            "{name} 与 {name}_FILE 只能设置一个"
        ))),
        (Some(value), None) => {
            validate_token(&value)
                .map_err(|_| ExecutorError::Launch(format!("{name} 配置无效")))?;
            Ok(Some(value))
        }
        (None, Some(path)) => {
            let value = std::fs::read_to_string(path)
                .map_err(|_| ExecutorError::Launch(format!("无法读取 {name}_FILE")))?;
            let value = value.trim_end_matches(['\r', '\n']).to_string();
            validate_token(&value)
                .map_err(|_| ExecutorError::Launch(format!("{name}_FILE 配置无效")))?;
            Ok(Some(value))
        }
        (None, None) => Ok(None),
    }
}

fn parse_timeout(raw: Option<&str>) -> Result<Duration, ExecutorError> {
    let secs = raw
        .map(|value| value.parse::<u64>())
        .transpose()
        .map_err(|_| ExecutorError::Launch("URSI_CLIENT_TIMEOUT_SECS 必须是整数".into()))?
        .unwrap_or(120);
    if !(1..=86_400).contains(&secs) {
        return Err(ExecutorError::Launch(
            "URSI_CLIENT_TIMEOUT_SECS 必须在 1..=86400 内".into(),
        ));
    }
    Ok(Duration::from_secs(secs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};
    use ursi_domain::ExecutorKind;

    async fn peer() -> (String, TcpListener) {
        let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
        let url = format!(
            "ws://127.0.0.1:{}/acp",
            listener.local_addr().unwrap().port()
        );
        (url, listener)
    }

    async fn accept(listener: &TcpListener) -> WebSocketStream<TcpStream> {
        let (stream, _) = listener.accept().await.unwrap();
        accept_async(stream).await.unwrap()
    }

    async fn recv(ws: &mut WebSocketStream<TcpStream>) -> Value {
        serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap()
    }

    async fn send(ws: &mut WebSocketStream<TcpStream>, value: Value) {
        ws.send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    async fn request(listener: &TcpListener, method: &str) -> (WebSocketStream<TcpStream>, Value) {
        let mut ws = accept(listener).await;
        let init = recv(&mut ws).await;
        assert_eq!(init["method"], "initialize");
        reply(&mut ws, &init, json!({"protocolVersion":1})).await;
        let req = recv(&mut ws).await;
        assert_eq!(req["method"], method);
        if method != "session/new" {
            assert_eq!(req["params"]["sessionId"], "s1");
        }
        (ws, req)
    }

    async fn reply(ws: &mut WebSocketStream<TcpStream>, req: &Value, result: Value) {
        send(
            ws,
            json!({"jsonrpc":"2.0", "id":req["id"], "result":result}),
        )
        .await;
    }

    async fn new_session(listener: &TcpListener) {
        let (mut ws, req) = request(listener, "session/new").await;
        assert_eq!(
            req["params"],
            json!({"cwd":"/ursi/workspace/repo","mcpServers":[]})
        );
        reply(&mut ws, &req, json!({"sessionId":"s1"})).await;
    }

    async fn close_session(listener: &TcpListener) {
        let (mut ws, req) = request(listener, "_ursi/session/close").await;
        reply(&mut ws, &req, json!({})).await;
    }

    fn spec() -> SessionSpec {
        SessionSpec {
            run_id: "run-1".into(),
            node_id: "node-1".into(),
            capability: CapabilityConfig {
                prompt: "role".into(),
                model: Some("runtime-profile".into()),
                skills: vec![],
                mcp_servers: vec![],
            },
        }
    }

    fn config(url: String) -> WebSocketAcpConfig {
        WebSocketAcpConfig {
            url,
            session_token: "test-session-token".into(),
            timeout: Duration::from_secs(3),
        }
    }

    #[tokio::test]
    async fn real_websocket_uses_runtime_subset_and_closes_session() {
        let (url, listener) = peer().await;
        let server = tokio::spawn(async move {
            new_session(&listener).await;
            let (mut ws, prompt) = request(&listener, "session/prompt").await;
            assert_eq!(
                prompt["params"]["prompt"],
                json!([{"type":"text","text":"role\n\ntask\n\nartifact"}])
            );
            send(&mut ws, json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"read"}}})).await;
            for text in ["do", "ne\n", "  "] {
                send(&mut ws, json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}})).await;
            }
            reply(&mut ws, &prompt, json!({"stopReason":"end_turn"})).await;
            close_session(&listener).await;
        });
        let controller = WebSocketSessionController::new(config(url)).unwrap();
        let handle = controller.create_session(spec()).await.unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_for_sink = Arc::clone(&events);
        let input = InvocationInput {
            prompt: "task".into(),
            artifact_context: "artifact".into(),
            run_id: "run-1".into(),
            node_id: "node-1".into(),
        };
        let result = controller
            .prompt(&handle, &input, &|event| {
                events_for_sink.lock().unwrap().push(event)
            })
            .await
            .unwrap();
        assert_eq!(result.output, "done\n  ");
        {
            let events = events.lock().unwrap();
            assert_eq!(events.len(), 4);
            assert_eq!(events[0].name, "tool.tool_call");
            assert_eq!(events[0].attributes["runId"], "run-1");
            assert_eq!(events[0].attributes["nodeId"], "node-1");
        }
        assert_eq!(
            controller.close(&handle).await.unwrap(),
            ExecutionState::Completed
        );
        assert!(controller.sessions.lock().unwrap().is_empty());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn status_and_cancel_on_separate_connections_during_prompt() {
        let (url, listener) = peer().await;
        let (started, ready) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            new_session(&listener).await;
            let (mut prompt_ws, prompt) = request(&listener, "session/prompt").await;
            started.send(()).unwrap();
            let (mut ws, status) = request(&listener, "_ursi/session/status").await;
            reply(
                &mut ws,
                &status,
                json!({"sessionId":"s1", "state":"running", "pid":42}),
            )
            .await;
            let (_, cancel) = request(&listener, "session/cancel").await;
            assert!(cancel.get("id").is_none());
            reply(&mut prompt_ws, &prompt, json!({"stopReason":"cancelled"})).await;
            close_session(&listener).await;
        });
        let controller = WebSocketSessionController::new(config(url)).unwrap();
        let handle = controller.create_session(spec()).await.unwrap();
        let input = InvocationInput::default();
        let (outcome, ()) = tokio::join!(controller.prompt(&handle, &input, &|_| {}), async {
            ready.await.unwrap();
            assert_eq!(
                controller.status(&handle).await.unwrap()["state"],
                "running"
            );
            controller.cancel(&handle).await.unwrap();
        });
        assert!(matches!(outcome, Err(SessionError::Execution(_))));
        assert_eq!(
            controller.close(&handle).await.unwrap(),
            ExecutionState::Cancelled
        );
        assert!(controller.sessions.lock().unwrap().is_empty());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn close_without_confirmed_prompt_is_unknown() {
        let (url, listener) = peer().await;
        let server = tokio::spawn(async move {
            new_session(&listener).await;
            close_session(&listener).await;
        });
        let controller = WebSocketSessionController::new(config(url)).unwrap();
        let handle = controller.create_session(spec()).await.unwrap();
        assert_eq!(
            controller.close(&handle).await.unwrap(),
            ExecutionState::Unknown
        );
        assert!(controller.sessions.lock().unwrap().is_empty());
        server.await.unwrap();
    }

    struct NoEnv;
    #[async_trait]
    impl ExecutionEnv for NoEnv {
        async fn exec(&self, _: &str) -> Result<(i32, String), ursi_domain::EnvError> {
            unreachable!()
        }
        async fn write_file(&self, _: &str, _: &[u8]) -> Result<(), ursi_domain::EnvError> {
            unreachable!()
        }
        async fn read_file(&self, _: &str) -> Result<Vec<u8>, ursi_domain::EnvError> {
            unreachable!()
        }
    }

    fn role() -> Role {
        Role {
            id: "r".into(),
            name: "role".into(),
            prompt: "role".into(),
            model: None,
            skills: vec![],
            mcp_servers: vec![],
            executor_id: None,
        }
    }
    async fn run(
        runner: &AcpRunner,
        role: &Role,
        kind: ExecutorKind,
    ) -> Result<InvocationResult, ExecutorError> {
        let executor = Executor {
            id: "runtime-acp".into(),
            name: "runtime".into(),
            kind,
        };
        runner
            .run(
                &InvocationInput::default(),
                role,
                &executor,
                Arc::new(NoEnv),
                &|_| {},
            )
            .await
    }

    #[tokio::test]
    async fn runner_rejects_unsupported_kind_and_model_before_connecting() {
        let runner = AcpRunner::new(config("ws://127.0.0.1:1/acp".into())).unwrap();
        for kind in [ExecutorKind::Mock, ExecutorKind::Cli("other".into())] {
            assert!(
                matches!(run(&runner,&role(),kind).await, Err(ExecutorError::Launch(e)) if e.contains("executor.kind"))
            );
        }
        for model in ["", "runtime-profile ", "other"] {
            let role = Role {
                model: Some(model.into()),
                ..role()
            };
            assert!(
                matches!(run(&runner,&role,ExecutorKind::Cli("runtime-acp".into())).await, Err(ExecutorError::Launch(e)) if e.contains("model"))
            );
        }
    }

    #[tokio::test]
    async fn runner_forbids_resubmit_after_unknown_cancel_or_failed_close() {
        for reason in [None, Some("invalid"), Some("cancelled"), Some("end_turn")] {
            let (url, listener) = peer().await;
            let server = tokio::spawn(async move {
                new_session(&listener).await;
                let (mut ws, req) = request(&listener, "session/prompt").await;
                assert_eq!(
                    req["params"]["prompt"],
                    json!([{"type":"text","text":"role"}])
                );
                if let Some(reason) = reason {
                    reply(&mut ws, &req, json!({"stopReason":reason})).await;
                }
                drop(ws);
                match reason {
                    Some("end_turn") => {
                        let (mut ws, req) = request(&listener, "_ursi/session/close").await;
                        send(&mut ws, json!({"jsonrpc":"2.0", "id":req["id"], "error":{"code":-1,"message":"close failed"}})).await;
                    }
                    Some("cancelled") => close_session(&listener).await,
                    _ => (),
                }
            });
            let runner = AcpRunner::new(config(url)).unwrap();
            assert!(
                matches!(
                    run(&runner, &role(), ExecutorKind::Cli("runtime-acp".into())).await,
                    Err(ExecutorError::DoNotRetry(_))
                ),
                "{reason:?}"
            );
            assert!(runner.controller.sessions.lock().unwrap().is_empty());
            server.await.unwrap();
        }
    }

    #[test]
    fn env_opts_out_only_when_absent() {
        let from = |pairs: &[(&str, &str)]| {
            AcpRunner::from_vars(|name| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, v)| v.into())
            })
        };
        let url = ("URSI_ACP_URL", "ws://127.0.0.1/acp");
        let token = ("URSI_SESSION_TOKEN", "test-token");
        assert!(from(&[]).unwrap().is_none());
        assert!(from(&[url, token]).unwrap().is_some());
        for pairs in [
            vec![url],
            vec![token],
            vec![("URSI_ACP_URL", " ")],
            vec![("URSI_CLIENT_TIMEOUT_SECS", "5")],
            vec![url, token, ("URSI_CLIENT_TIMEOUT_SECS", "")],
            vec![url, token, ("URSI_CLIENT_TIMEOUT_SECS", "86401")],
            vec![url, token, ("URSI_SESSION_TOKEN_FILE", "/ignored")],
            vec![token, ("URSI_ACP_URL", "https://host/acp")],
            vec![token, ("URSI_ACP_URL", "ws://user@host/acp")],
        ] {
            assert!(from(&pairs).is_err());
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            assert!(
                AcpRunner::from_vars(|name| (name == "URSI_ACP_URL")
                    .then(|| std::ffi::OsString::from_vec(vec![0xff])))
                .is_err()
            );
        }
    }

    #[test]
    fn unsupported_runtime_capabilities_are_rejected() {
        let error = WebSocketSessionController::reject_runtime_unsupported(&CapabilityConfig {
            prompt: String::new(),
            model: None,
            skills: vec!["skill".into()],
            mcp_servers: vec![],
        })
        .unwrap_err();
        assert!(error.to_string().contains("skills"));
    }
}
