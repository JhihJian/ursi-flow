//! 会话控制协议：基于 ACP 帧传输实现 create_session / prompt / cancel / close。
//!
//! 此控制器使用注入的 [`AcpFrameTransport`]，与 [`crate::channel::acp`] 的长度帧对齐。
//! 关联字段是帧协议的一部分。正式 Runtime `/acp` 使用 WebSocket JSON-RPC，
//! 由 [`crate::runtime_acp`] 按运行绑定接入，不发送这些扩展字段。
//!
//! 关联纪律：每个会话持有统一的关联标识（run_id、node_id、session_id），
//! create_session 发送的 `session/new`、prompt 发送的 `session/prompt`、
//! cancel 发送的 `session/cancel`、close 发送的 `_ursi/session/close`
//! 请求参数都携带这些标识。JSON-RPC 层用自增请求 id 做请求-响应关联。
//!
//! 错误纪律：连接中断（`send` 报错或 `recv` 返回 `None`）映射为
//! [`SessionError::ConnectionClosed`]，与任务失败（[`SessionError::Execution`]，
//! 对端 JSON-RPC error）可区分；未知结果的任务不自动重复提交，重试策略
//! 由 server engine 决定。

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use flow_core::agent_runtime::capability::CapabilityConfig;
use flow_core::agent_runtime::{InvocationInput, InvocationResult};

/// ACP 帧传输抽象，对应 [`crate::channel::acp`] 的帧边界。
///
/// `send` 发送一条 UTF-8 JSON 消息（对端按帧边界读取）；`recv` 读取下一条
/// 消息，返回 `None` 表示连接断开（EOF）。实现保证消息保序。
#[async_trait]
pub trait AcpFrameTransport: Send {
    /// 发送一条 JSON 消息。失败（如连接已断）返回错误描述。
    async fn send(&self, frame: String) -> Result<(), String>;

    /// 读取下一条 JSON 消息；`None` 映射为 [`SessionError::ConnectionClosed`]。
    async fn recv(&self) -> Option<String>;
}

/// 会话规格：创建会话时的运行上下文与角色能力配置。
///
/// run_id / node_id 是贯穿一次执行的关联标识，随每个请求携带。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpec {
    pub run_id: String,
    pub node_id: String,
    /// 角色能力配置：prompt、model、skills、mcp_servers。
    pub capability: CapabilityConfig,
}

/// 会话句柄：本地会话 id 加对端 sessionId 与关联标识。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHandle {
    /// 本地会话标识，格式 `{run_id}/{node_id}`。
    pub id: String,
    /// 对端 session-service 分配的 sessionId。
    pub session_id: String,
    pub run_id: String,
    pub node_id: String,
}

impl SessionHandle {
    /// 从关联标识构造本地会话 id。
    pub fn local_id(run_id: &str, node_id: &str) -> String {
        format!("{run_id}/{node_id}")
    }
}

/// 会话执行终态：close 返回的可判断状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    /// 对端确认会话已回收。
    Completed,
    /// 对端确认会话已取消。
    Cancelled,
    /// 连接已断，无法确认回收结果。
    Unknown,
}

/// 会话控制接口：创建会话、执行、取消、关闭。
///
/// 取 `&self` 以便多任务共享同一控制器；可变状态在
/// [`AcpSessionController`] 内部以互斥保护。
#[async_trait]
pub trait SessionControl: Send + Sync {
    /// 创建会话并下发角色能力配置。
    async fn create_session(&self, spec: SessionSpec) -> Result<SessionHandle, SessionError>;

    /// 在会话上执行一次 prompt，执行期间事件经 sink 回流。
    async fn prompt(
        &self,
        session: &SessionHandle,
        input: &InvocationInput,
        sink: flow_core::agent_runtime::EventSink<'_>,
    ) -> Result<InvocationResult, SessionError>;

    /// 取消会话内当前执行（若在途）。
    async fn cancel(&self, session: &SessionHandle) -> Result<(), SessionError>;

    /// 关闭并回收会话，返回可判断的终态。
    async fn close(&self, session: &SessionHandle) -> Result<ExecutionState, SessionError>;
}

/// 会话控制错误。
///
/// `ConnectionClosed` 与 `Execution` 必须可区分：前者意味着结果未知，
/// 调用方不得自动重复提交；后者是对端明确报告的任务失败，重试策略由
/// server engine 决定。
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum SessionError {
    /// 连接中断，结果未知。与任务失败可区分，不自动重试。
    #[error("ACP 连接已断开，结果未知（不自动重试）")]
    ConnectionClosed,
    /// 对端明确报告的任务失败（JSON-RPC error）。
    #[error("任务执行失败：{0}")]
    Execution(String),
    /// 会话创建失败（对端拒绝 session/new）。
    #[error("创建会话失败：{0}")]
    SessionSetup(String),
    /// 能力配置不被支持（未知能力字段等）。
    #[error("能力配置不被支持：{0}")]
    UnsupportedCapability(#[from] flow_core::agent_runtime::capability::CapabilityError),
    /// 会话 id 未通过 create_session 创建或已被关闭。
    #[error("会话不存在：{0}")]
    UnknownSession(String),
    /// 帧内容不是合法 JSON-RPC 或事件归属不匹配。
    #[error("协议错误：{0}")]
    Protocol(String),
}

/// 把 JSON-RPC error 对象压缩为单行描述（错误码加消息，不含凭据语义）。
fn format_jsonrpc_error(err: &Value) -> String {
    let code = err.get("code").cloned().unwrap_or(Value::Null);
    let message = err
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("（无错误消息）");
    format!("code={code} message={message}")
}

/// 一条 ACP 通知（session/update 等无 id 帧）解析后的中间表示。
#[derive(Debug, Clone)]
pub struct AcpEvent {
    /// 关联标识（run_id/node_id/sessionId 组合），来自 params。
    pub correlation: String,
    /// 对端会话 id。
    pub session_id: String,
    /// update 负载原样保留，供事件映射层使用。
    pub update: Value,
}

/// ACP 事件解析：识别无 id 的通知帧，提取归属标识与 update 负载。
impl AcpEvent {
    /// 解析一条 JSON 消息；不是通知（携带 id / 是响应）返回 `None`。
    pub fn parse(msg: &Value) -> Option<AcpEvent> {
        if msg.get("id").is_some() {
            return None;
        }
        let method = msg.get("method")?.as_str()?;
        if !method.eq("session/update") && !method.eq("session/cancel") {
            return None;
        }
        let params = msg.get("params")?;
        let session_id = params.get("sessionId")?.as_str()?.to_string();
        let update = params.get("update").cloned().unwrap_or(Value::Null);
        let correlation = params
            .get("correlation")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| session_id.clone());
        Some(AcpEvent { correlation, session_id, update })
    }
}

/// JSON-RPC 响应中 result.sessionId 的提取。
fn extract_session_id(result: &Value) -> Result<String, SessionError> {
    result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| SessionError::Protocol("响应缺少 sessionId".to_string()))
}

/// ACP stopReason 到执行终态的映射。
///
/// 只有明确的停止原因才是可判断的终态。
pub fn stop_reason_to_state(stop_reason: &str) -> ExecutionState {
    match stop_reason {
        "cancelled" => ExecutionState::Cancelled,
        "end_turn" => ExecutionState::Completed,
        _ => ExecutionState::Unknown,
    }
}

/// session/update 负载到统一遥测事件的映射。
///
/// 事件携带关联标识（run_id / node_id / sessionId），保证归属当前会话。
/// 只覆盖 AGENT-CONTRACT 列出的 update 形态：文本 chunk、tool_call /
/// tool_call_update；未知形态映射为 log 事件原样透出，不丢弃。
pub fn map_acp_event_to_telemetry(
    event: &AcpEvent,
    run_id: &str,
    node_id: &str,
) -> TelemetryEvent {
    let kind = event
        .update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let (category, name, phase, message) = match kind {
        "agent_message_chunk" => (
            EventCategory::Node,
            "agent.message".to_string(),
            EventPhase::Progress,
            event
                .update
                .pointer("/content/text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ),
        "tool_call" | "tool_call_update" => (
            EventCategory::Tool,
            format!("tool.{kind}"),
            if kind == "tool_call" {
                EventPhase::Start
            } else {
                EventPhase::Progress
            },
            event
                .update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ),
        _ => (
            EventCategory::Log,
            format!("acp.{kind}"),
            EventPhase::Progress,
            event.update.to_string(),
        ),
    };
    let mut attributes = HashMap::new();
    attributes.insert("runId".to_string(), json!(run_id));
    attributes.insert("nodeId".to_string(), json!(node_id));
    attributes.insert("sessionId".to_string(), json!(event.session_id));
    attributes.insert("correlation".to_string(), json!(event.correlation));
    TelemetryEvent { category, name, phase, message, attributes }
}

use flow_core::domain::{EventCategory, EventPhase, TelemetryEvent};

/// 基于 ACP 帧传输的会话控制器实现。
///
/// 协议状态（自增请求 id、在途请求、会话终态）放在
/// `Arc<Mutex<...>>` 内，接口方法在锁外做帧传输等待，避免跨 await 持锁。
/// 泛型参数 `T` 为帧传输实现，测试注入进程内 mpsc pair。
pub struct AcpSessionController<T: AcpFrameTransport> {
    transport: T,
    state: Mutex<ControllerState>,
}

/// 协议可变状态：请求 id 分配与每会话终态记录。
#[derive(Default)]
struct ControllerState {
    next_id: u64,
    /// 对端 sessionId -> ExecutionState，prompt 结束与 close 后记录终态。
    session_states: HashMap<String, ExecutionState>,
}

impl<T: AcpFrameTransport> AcpSessionController<T> {
    /// 用注入的帧传输构造控制器。
    pub fn new(transport: T) -> Self {
        Self { transport, state: Mutex::new(ControllerState::default()) }
    }

    /// 分配下一个 JSON-RPC 请求 id（自增）。
    fn next_request_id(state: &mut ControllerState) -> u64 {
        state.next_id += 1;
        state.next_id
    }

    /// 发送一条 JSON-RPC 请求并等待同 id 响应。
    ///
    /// 等待期间到达的通知帧经 `on_event` 回流。连接断开统一映射为
    /// [`SessionError::ConnectionClosed`]。响应 error 映射为
    /// [`SessionError::Execution`]（任务失败）。事件归属由
    /// `expect_session_id` 校验，不匹配返回 [`SessionError::Protocol`]。
    async fn request(
        &self,
        method: &str,
        params: Value,
        expect_session_id: &str,
        on_event: &(dyn Fn(AcpEvent) + Send + Sync),
    ) -> Result<Value, SessionError> {
        let id = {
            let mut state = self.state.lock().unwrap();
            Self::next_request_id(&mut state)
        };
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let frame = serde_json::to_string(&message)
            .map_err(|e| SessionError::Protocol(format!("请求序列化失败：{e}")))?;
        self.transport
            .send(frame)
            .await
            .map_err(|_| SessionError::ConnectionClosed)?;

        let mut pending_id = Some(id);
        let result = loop {
            let Some(frame) = self.transport.recv().await else {
                pending_id = None;
                break Err(SessionError::ConnectionClosed);
            };
            let msg: Value = match serde_json::from_str(&frame) {
                Ok(msg) => msg,
                Err(e) => break Err(SessionError::Protocol(format!("帧反序列化失败：{e}"))),
            };
            // 请求-响应关联：JSON-RPC id 匹配当前在途请求才算响应。
            if msg.get("id") == Some(&json!(id))
                && (msg.get("result").is_some() || msg.get("error").is_some())
            {
                break match msg.get("error") {
                    Some(err) => Err(SessionError::Execution(format_jsonrpc_error(err))),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
            }
            if let Some(event) = AcpEvent::parse(&msg) {
                if event.session_id != expect_session_id {
                    break Err(SessionError::Protocol(format!(
                        "事件归属不匹配：期待会话 {expect_session_id}，收到 {}",
                        event.session_id
                    )));
                }
                on_event(event);
            }
            // 其他帧（未知方法通知、陈旧响应）视为噪音忽略。
        };
        if pending_id.take().is_none() {
            // 连接已断：记录未知终态，不自动重试该请求。
            let mut state = self.state.lock().unwrap();
            state.session_states.insert(expect_session_id.to_string(), ExecutionState::Unknown);
        }
        result
    }
}

#[async_trait]
impl<T: AcpFrameTransport + Sync + 'static> SessionControl for AcpSessionController<T> {
    /// 发送 `session/new`，params 携带关联标识与能力配置。
    ///
    /// 结果 sessionId 回填到句柄，run_id/node_id 贯穿会话生命周期。
    async fn create_session(&self, spec: SessionSpec) -> Result<SessionHandle, SessionError> {
        let SessionSpec { run_id, node_id, capability } = spec;
        let params = json!({
            "runId": run_id,
            "nodeId": node_id,
            "correlation": SessionHandle::local_id(&run_id, &node_id),
            "cwd": "/ursi/workspace/repo",
            "mcpServers": capability.mcp_servers,
            "config": capability,
        });
        let result = self
            .request("session/new", params, "", &|_| {})
            .await
            .map_err(|e| match e {
                SessionError::Execution(msg) => SessionError::SessionSetup(msg),
                other => other,
            })?;
        let session_id = extract_session_id(&result)?;
        Ok(SessionHandle {
            id: SessionHandle::local_id(&run_id, &node_id),
            session_id,
            run_id,
            node_id,
        })
    }

    /// 发送 `session/prompt`：sessionId、prompt 内容与关联标识。
    ///
    /// 执行期间 `session/update` 通知映射为统一事件经 sink 回流；结果
    /// stopReason 决定执行状态，Cancelled 也以结果形式返回（取消是明确
    /// 交付的状态，不是失败）。sink 为弱引用语义：同步调用不阻塞，消费者
    /// 缺失不影响结果返回。
    async fn prompt(
        &self,
        session: &SessionHandle,
        input: &InvocationInput,
        sink: flow_core::agent_runtime::EventSink<'_>,
    ) -> Result<InvocationResult, SessionError> {
        let correlation = SessionHandle::local_id(&session.run_id, &session.node_id);
        let params = json!({
            "sessionId": session.session_id,
            "runId": session.run_id,
            "nodeId": session.node_id,
            "correlation": correlation,
            "prompt": [
                {
                    "type": "text",
                    "text": if input.prompt.trim().is_empty() {
                        input.artifact_context.clone()
                    } else if input.artifact_context.trim().is_empty() {
                        input.prompt.clone()
                    } else {
                        format!("{}\n\n{}", input.prompt, input.artifact_context)
                    },
                },
            ],
        });
        let output = std::sync::Arc::new(Mutex::new(String::new()));
        let output_for_event = output.clone();
        let result = self
            .request("session/prompt", params, &session.session_id, &move |event| {
                let telemetry =
                    map_acp_event_to_telemetry(&event, &session.run_id, &session.node_id);
                if telemetry.category == EventCategory::Node && telemetry.name == "agent.message" {
                    let mut out = output_for_event.lock().unwrap();
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(&telemetry.message);
                }
                sink(telemetry);
            })
            .await?;
        let output = Mutex::into_inner(
            std::sync::Arc::into_inner(output).expect("输出聚合句柄应已释放"),
        )
        .expect("输出聚合锁未中毒");
        let state = stop_reason_to_state(result["stopReason"].as_str().unwrap_or_default());
        {
            let mut st = self.state.lock().unwrap();
            st.session_states.insert(session.session_id.clone(), state);
        }
        if state == ExecutionState::Unknown {
            return Err(SessionError::Protocol("prompt 缺少已知 stopReason".into()));
        }
        // 连接中断时 request 已返回 ConnectionClosed，不会到达这里；
        // 记录的终态与结果一致：cancelled 或 completed。
        Ok(InvocationResult {
            output,
            artifacts: Vec::new(),
            tokens: 0,
        })
    }

    /// 发送 `session/cancel` 通知。契约定义 cancel 是通知，无响应。
    async fn cancel(&self, session: &SessionHandle) -> Result<(), SessionError> {
        let message = json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": {
                "sessionId": session.session_id,
                "runId": session.run_id,
                "nodeId": session.node_id,
            },
        });
        let frame = serde_json::to_string(&message)
            .map_err(|e| SessionError::Protocol(format!("请求序列化失败：{e}")))?;
        self.transport
            .send(frame)
            .await
            .map_err(|_| SessionError::ConnectionClosed)?;
        Ok(())
    }

    /// 发送 `_ursi/session/close`，params 携带关联标识。
    ///
    /// 结果携带 `state`（completed/cancelled）；连接断开时无法确认回收，
    /// 返回 [`ExecutionState::Unknown`]。
    async fn close(&self, session: &SessionHandle) -> Result<ExecutionState, SessionError> {
        let params = json!({
            "sessionId": session.session_id,
            "runId": session.run_id,
            "nodeId": session.node_id,
            "correlation": SessionHandle::local_id(&session.run_id, &session.node_id),
        });
        let result = match self.request("_ursi/session/close", params, &session.session_id, &|_| {}).await {
            Ok(result) => result,
            Err(SessionError::ConnectionClosed) => return Ok(ExecutionState::Unknown),
            Err(SessionError::UnknownSession(_)) => return Ok(ExecutionState::Unknown),
            Err(e) => return Err(e),
        };
        let known = self.state.lock().unwrap().session_states.remove(&session.session_id);
        Ok(match result.get("state") {
            Some(v) if v == "completed" => ExecutionState::Completed,
            Some(v) if v == "cancelled" => ExecutionState::Cancelled,
            None if result.is_object() => known.unwrap_or(ExecutionState::Unknown),
            _ => ExecutionState::Unknown,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tokio::sync::{mpsc, Mutex as AsyncMutex};

    /// 控制器侧传输端：tokio mpsc 包装，供 AcpFrameTransport 实现使用。
    #[derive(Clone)]
    struct ControllerEnd {
        to_peer: mpsc::UnboundedSender<String>,
        from_peer: ArcAsyncMutex<mpsc::UnboundedReceiver<String>>,
    }

    type ArcAsyncMutex<T> = std::sync::Arc<AsyncMutex<T>>;

    #[async_trait]
    impl AcpFrameTransport for ControllerEnd {
        async fn send(&self, frame: String) -> Result<(), String> {
            self.to_peer.send(frame).map_err(|_| "对端已断开".to_string())
        }

        async fn recv(&self) -> Option<String> {
            self.from_peer.lock().await.recv().await
        }
    }

    /// 测试对端（mock session-service 侧）：收控制器的请求，回响应与事件。
    struct PeerEnd {
        from_controller: mpsc::UnboundedReceiver<String>,
        to_controller: Option<mpsc::UnboundedSender<String>>,
    }

    impl PeerEnd {
        /// 读取下一条控制器请求帧并解析为 JSON。
        async fn next_frame(&mut self) -> Value {
            let frame = self
                .from_controller
                .recv()
                .await
                .expect("对端通道意外关闭");
            serde_json::from_str(&frame).expect("控制器发来的帧不是合法 JSON")
        }

        /// 回送对指定请求 id 的成功响应。
        fn reply_ok(&self, id: &Value, result: Value) {
            let msg = json!({ "jsonrpc": "2.0", "id": id, "result": result });
            self.to_controller
                .as_ref()
                .expect("连接已断")
                .send(serde_json::to_string(&msg).unwrap())
                .unwrap();
        }

        /// 回送对指定请求 id 的 JSON-RPC error（任务失败）。
        fn reply_error(&self, id: &Value, code: i64, message: &str) {
            let msg = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": code, "message": message },
            });
            self.to_controller
                .as_ref()
                .expect("连接已断")
                .send(serde_json::to_string(&msg).unwrap())
                .unwrap();
        }

        /// 发送 session/update 通知（事件），携带会话与关联标识。
        fn send_update(&self, session_id: &str, correlation: &str, update: Value) {
            let msg = json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "correlation": correlation,
                    "update": update,
                },
            });
            self.to_controller
                .as_ref()
                .expect("连接已断")
                .send(serde_json::to_string(&msg).unwrap())
                .unwrap();
        }

        /// 模拟连接断开：控制器 recv 将返回 None。
        fn drop_connection(&mut self) {
            self.to_controller = None;
        }

        /// 断言通道里已没有更多来自控制器的帧（用于证明未自动重试）。
        fn assert_no_more_frames(&mut self) {
            assert!(
                self.from_controller.try_recv().is_err(),
                "控制器不应再发送任何帧"
            );
        }
    }

    /// 建立控制器与对端的进程内帧通道。
    fn make_pair() -> (AcpSessionController<ControllerEnd>, PeerEnd) {
        let (to_peer, peer_in) = mpsc::unbounded_channel();
        let (to_controller, controller_in) = mpsc::unbounded_channel();
        let transport = ControllerEnd {
            to_peer,
            from_peer: ArcAsyncMutex::new(AsyncMutex::new(controller_in)),
        };
        let controller = AcpSessionController::new(transport);
        let peer = PeerEnd {
            from_controller: peer_in,
            to_controller: Some(to_controller),
        };
        (controller, peer)
    }

    fn test_spec() -> SessionSpec {
        SessionSpec {
            run_id: "run-1".to_string(),
            node_id: "node-1".to_string(),
            capability: CapabilityConfig {
                prompt: "评审提示词".to_string(),
                model: Some("claude-sonnet".to_string()),
                skills: vec!["code-review".to_string()],
                mcp_servers: Vec::new(),
            },
        }
    }

    /// 完成一次握手：对端处理 session/new 并回 sessionId。
    async fn handshake(controller: &AcpSessionController<ControllerEnd>, peer: &mut PeerEnd) -> SessionHandle {
        let spec = test_spec();
        let create = controller.create_session(spec);
        tokio::join!(create, async {
            let frame = peer.next_frame().await;
            assert_eq!(frame["method"], "session/new");
            peer.reply_ok(&frame["id"], json!({ "sessionId": "sess-1" }));
        })
        .0
        .expect("create_session 失败")
    }

    /// SPEC 验收（会话控制）：一次执行的请求、事件和结果保持同一关联标识。
    #[tokio::test]
    async fn correlation_ids_stay_consistent_across_request_events_result() {
        let (controller, mut peer) = make_pair();
        let handle = handshake(&controller, &mut peer).await;
        // 关联标识贯穿：本地会话 id 由 run_id/node_id 组成。
        assert_eq!(handle.id, "run-1/node-1");
        assert_eq!(handle.run_id, "run-1");
        assert_eq!(handle.node_id, "node-1");
        assert_eq!(handle.session_id, "sess-1");

        let input = InvocationInput {
            prompt: "审查这段代码".to_string(),
            artifact_context: String::new(),
            run_id: handle.run_id.clone(),
            node_id: handle.node_id.clone(),
        };
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::<TelemetryEvent>::new()));
        let events_for_sink = events.clone();
        let sink = move |event: TelemetryEvent| {
            events_for_sink.lock().unwrap().push(event);
        };

        let prompt_fut = controller.prompt(&handle, &input, &sink);
        let result = tokio::join!(prompt_fut, async {
            let frame = peer.next_frame().await;
            // 请求携带同一组关联标识。
            assert_eq!(frame["method"], "session/prompt");
            assert_eq!(frame["params"]["runId"], "run-1");
            assert_eq!(frame["params"]["nodeId"], "node-1");
            assert_eq!(frame["params"]["sessionId"], "sess-1");
            assert_eq!(frame["params"]["correlation"], "run-1/node-1");
            // 执行期间对端发事件，事件归属当前会话。
            peer.send_update(
                "sess-1",
                "run-1/node-1",
                json!({ "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": "开始审查" } }),
            );
            peer.send_update(
                "sess-1",
                "run-1/node-1",
                json!({ "sessionUpdate": "tool_call", "title": "读取文件",
                        "toolCallId": "t1" }),
            );
            peer.reply_ok(&frame["id"], json!({ "stopReason": "end_turn" }));
        })
        .0
        .expect("prompt 失败");

        // 结果与事件同源：输出来自回流的消息 chunk。
        assert_eq!(result.output, "开始审查");
        let got = events.lock().unwrap();
        assert_eq!(got.len(), 2, "两条事件都应回流");
        for event in got.iter() {
            let session = event.attributes.get("sessionId").unwrap();
            let correlation = event.attributes.get("correlation").unwrap();
            assert_eq!(session, "sess-1");
            assert_eq!(correlation, "run-1/node-1");
        }
        // 事件归属与终态一致：都指向 sess-1 / run-1/node-1。
        assert_eq!(got[0].category, EventCategory::Node);
        assert_eq!(got[1].category, EventCategory::Tool);
    }

    /// SPEC 验收（会话控制）：取消或关闭请求能到达对应会话，并返回可判断的执行状态。
    #[tokio::test]
    async fn cancel_and_close_reach_session_and_return_judgeable_state() {
        let (controller, mut peer) = make_pair();
        let handle = handshake(&controller, &mut peer).await;

        let input = InvocationInput {
            prompt: "长任务".to_string(),
            artifact_context: String::new(),
            run_id: handle.run_id.clone(),
            node_id: handle.node_id.clone(),
        };
        let sink = |_: TelemetryEvent| {};

        // 在途 prompt：对端暂不回响应，先处理 cancel。
        let prompt_fut = controller.prompt(&handle, &input, &sink);
        // cancel 是通知，控制器侧立即返回，帧必须携带目标会话 id。
        let cancel_fut = controller.cancel(&handle);
        let (prompt_result, cancel_result, ()) = tokio::join!(prompt_fut, cancel_fut, async {
            let prompt_frame = peer.next_frame().await;
            assert_eq!(prompt_frame["method"], "session/prompt");
            assert_eq!(prompt_frame["params"]["sessionId"], "sess-1");
            assert_eq!(prompt_frame["params"]["runId"], "run-1");

            let cancel_frame = peer.next_frame().await;
            assert_eq!(cancel_frame["method"], "session/cancel");
            assert_eq!(cancel_frame["params"]["sessionId"], "sess-1");
            assert_eq!(cancel_frame["params"]["runId"], "run-1");

            // 取消送达后 prompt 以 cancelled stopReason 结束。
            peer.reply_ok(&prompt_frame["id"], json!({ "stopReason": "cancelled" }));
        });
        cancel_result.expect("cancel 失败");
        let result = prompt_result.expect("prompt 失败");
        // 取消是明确交付的终态：cancelled 状态可判断，不当作失败。
        assert_eq!(
            controller_state_of(&controller, "sess-1"),
            ExecutionState::Cancelled
        );
        let close_fut = controller.close(&handle);
        let (state, ()) = tokio::join!(close_fut, async {
            let close_frame = peer.next_frame().await;
            assert_eq!(close_frame["method"], "_ursi/session/close");
            assert_eq!(close_frame["params"]["sessionId"], "sess-1");
            assert_eq!(close_frame["params"]["runId"], "run-1");
            peer.reply_ok(&close_frame["id"], json!({ "state": "cancelled" }));
        });
        assert_eq!(state.expect("close 失败"), ExecutionState::Cancelled);
        assert_eq!(result.output, String::new());
    }

    /// 取 prompt 结束后控制器记录的会话终态（测试辅助）。
    fn controller_state_of<T: AcpFrameTransport>(
        controller: &AcpSessionController<T>,
        session_id: &str,
    ) -> ExecutionState {
        let st = controller.state.lock().unwrap();
        st.session_states
            .get(session_id)
            .copied()
            .unwrap_or(ExecutionState::Unknown)
    }

    /// SPEC 验收（会话控制）：连接中断可与任务失败区分，不自动重复提交未知结果的任务。
    #[tokio::test]
    async fn connection_closed_distinct_from_execution_failure_and_no_auto_retry() {
        // 场景一：任务失败（对端 JSON-RPC error）映射为 Execution。
        {
            let (controller, mut peer) = make_pair();
            let handle = handshake(&controller, &mut peer).await;
            let input = InvocationInput {
                prompt: "会失败的任务".to_string(),
                artifact_context: String::new(),
                run_id: handle.run_id.clone(),
                node_id: handle.node_id.clone(),
            };
            let sink = |_: TelemetryEvent| {};
            let prompt_fut = controller.prompt(&handle, &input, &sink);
            let result = tokio::join!(prompt_fut, async {
                let frame = peer.next_frame().await;
                peer.reply_error(&frame["id"], -32000, "模型调用失败");
            })
            .0;
            let err = result.expect_err("应当失败");
            assert!(
                matches!(err, SessionError::Execution(ref m) if m.contains("模型调用失败")),
                "对端明确失败应映射为 Execution，实际 {err:?}"
            );
            // 任务失败路径也不自动重试：对端不再收到任何帧。
            peer.assert_no_more_frames();
        }

        // 场景二：连接中断（recv 返回 None）映射为 ConnectionClosed。
        {
            let (controller, mut peer) = make_pair();
            let handle = handshake(&controller, &mut peer).await;
            let input = InvocationInput {
                prompt: "未知结果的任务".to_string(),
                artifact_context: String::new(),
                run_id: handle.run_id.clone(),
                node_id: handle.node_id.clone(),
            };
            let sink = |_: TelemetryEvent| {};
            let prompt_fut = controller.prompt(&handle, &input, &sink);
            let result = tokio::join!(prompt_fut, async {
                let frame = peer.next_frame().await;
                // 确认请求已送出后掐断连接。
                assert_eq!(frame["method"], "session/prompt");
                peer.drop_connection();
            })
            .0;
            let err = result.expect_err("应当失败");
            assert_eq!(err, SessionError::ConnectionClosed);
            // 未知结果的任务不自动重复提交：对端不再收到任何帧。
            peer.assert_no_more_frames();
        }
    }

    #[tokio::test]
    async fn close_without_confirmed_prompt_is_unknown() {
        let (controller, mut peer) = make_pair();
        let handle = handshake(&controller, &mut peer).await;
        let (state, ()) = tokio::join!(controller.close(&handle), async {
            let frame = peer.next_frame().await;
            assert_eq!(frame["method"], "_ursi/session/close");
            peer.reply_ok(&frame["id"], json!({}));
        });
        assert_eq!(state.unwrap(), ExecutionState::Unknown);
    }

    /// SPEC 验收（事件回流）：执行期间持续收到属于当前会话的事件，终态与最终结果一致。
    #[tokio::test]
    async fn events_belong_to_current_session_and_final_state_matches_result() {
        let (controller, mut peer) = make_pair();
        let handle = handshake(&controller, &mut peer).await;

        let input = InvocationInput {
            prompt: "持续观察".to_string(),
            artifact_context: String::new(),
            run_id: handle.run_id.clone(),
            node_id: handle.node_id.clone(),
        };
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::<TelemetryEvent>::new()));
        let events_for_sink = events.clone();
        let sink = move |event: TelemetryEvent| {
            events_for_sink.lock().unwrap().push(event);
        };

        let prompt_fut = controller.prompt(&handle, &input, &sink);
        let result = tokio::join!(prompt_fut, async {
            let frame = peer.next_frame().await;
            // 持续事件流：多条消息 chunk 与工具事件交错到达。
            for text in ["思考中", "调用工具", "整理输出"] {
                peer.send_update(
                    "sess-1",
                    "run-1/node-1",
                    json!({ "sessionUpdate": "agent_message_chunk",
                            "content": { "type": "text", "text": text } }),
                );
            }
            peer.send_update(
                "sess-1",
                "run-1/node-1",
                json!({ "sessionUpdate": "tool_call", "title": "搜索代码",
                        "toolCallId": "t1" }),
            );
            peer.send_update(
                "sess-1",
                "run-1/node-1",
                json!({ "sessionUpdate": "tool_call_update", "title": "搜索代码",
                        "toolCallId": "t1", "status": "completed" }),
            );
            peer.reply_ok(&frame["id"], json!({ "stopReason": "end_turn" }));
        })
        .0
        .expect("prompt 失败");

        // 事件都归属当前会话（对端只发 sess-1，归属校验通过即回流）。
        let got = events.lock().unwrap();
        assert_eq!(got.len(), 5, "5 条事件都应回流");
        // 终态与最终结果一致：输出聚合自消息 chunk，状态记录 completed。
        assert_eq!(
            result.output,
            "思考中\n调用工具\n整理输出",
            "结果输出应按序聚合自事件流"
        );
        assert_eq!(
            controller_state_of(&controller, "sess-1"),
            ExecutionState::Completed
        );
    }

    /// SPEC 验收（事件回流）：观测消费者缺失不会阻止控制请求和结果返回。
    ///
    /// 会话控制测试也覆盖 sink 弱引用语义；此处再验证事件回流 + MockRunner
    /// 的对应测试文件（tests/ 目录）引用的行为在本模块同样成立：sink 为空
    /// 操作时 prompt 照常完成并返回结果。
    #[tokio::test]
    async fn missing_sink_consumer_does_not_block_control() {
        let (controller, mut peer) = make_pair();
        let handle = handshake(&controller, &mut peer).await;

        let input = InvocationInput {
            prompt: "无消费者".to_string(),
            artifact_context: String::new(),
            run_id: handle.run_id.clone(),
            node_id: handle.node_id.clone(),
        };
        // sink 计数为 0：传入空操作回调（等价于无观测消费者注册）。
        let sink = |_: TelemetryEvent| {};
        let prompt_fut = controller.prompt(&handle, &input, &sink);
        let result = tokio::join!(prompt_fut, async {
            let frame = peer.next_frame().await;
            // 对端照常发事件，控制器照常回流（无消费者接收）。
            peer.send_update(
                "sess-1",
                "run-1/node-1",
                json!({ "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": "照常完成" } }),
            );
            peer.reply_ok(&frame["id"], json!({ "stopReason": "end_turn" }));
        })
        .0
        .expect("prompt 失败");

        // 消费者缺失不阻止控制：结果照常返回。
        assert_eq!(result.output, "照常完成");
    }
}
