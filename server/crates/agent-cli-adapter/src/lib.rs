//! 沙箱内 agent CLI 适配器。调用方拥有会话状态与客户端协议。
//!
//! 模块划分：
//! - [`capability`]：能力渲染（Role → 会话工作区配置文件集、CLI 参数向量、
//!   凭据占位清单），纯逻辑独立验证，含 materialize/cleanup；
//! - [`adapter`]：[`Runner`] 契约的 [`adapter::CliAdapter`]（经 ExecutionEnv
//!   启动 CLI 并采集输出产物）与 [`adapter::StubAdapter`]（确定性本地 mock，
//!   语义对齐 agent-runtime::MockRunner，供会话服务和流程测试）；
//! - [`local_env`]：进程内 LocalEnv 执行环境替身（临时目录 + sh），
//!   供本地验证与集成测试使用，生产装配方注入真正的沙箱 ExecutionEnv；
//! - `process` / `supervisor`：Pi RPC 长期进程与每会话 subreaper 监督
//!   （既有实现，与上述模块独立演进）。
mod adapter;
pub mod capability;
pub mod local_env;
mod process;
pub mod supervisor;

pub use adapter::{
    CliAdapter, StubAdapter, EVT_ARTIFACTS, EVT_CLEANUP, EVT_LAUNCH, EVT_RENDER,
    OUTPUT_CAPTURE_FILE,
};
pub use capability::{
    CapabilityManifest, CliRenderPlan, GenericCliPlan, PlannedCli, RenderContext, RenderError,
    RenderOutcome,
};
pub use process::{PiProcess, SpawnSpec};
use serde_json::{Value, json};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Pi process I/O failed")]
    Io(#[from] std::io::Error),
    #[error("Pi protocol failed")]
    Protocol,
    #[error("Pi command rejected")]
    Rejected,
    #[error("Pi model execution failed")]
    Model,
    #[error("Pi execution deadline exceeded")]
    Timeout,
    #[error("Pi supervisor exited")]
    SupervisorExited,
    #[error("Pi descendant cleanup could not be confirmed")]
    CleanupUnconfirmed,
}

/// 不携带提供方原始错误或命令内容，避免凭据进入错误响应与日志。
#[derive(Default)]
pub struct Turn {
    accepted: bool,
    settled: bool,
    failed: bool,
    completed_message: bool,
}

impl Turn {
    pub fn observe(&mut self, event: &Value, prompt_id: &str) -> Result<bool, Error> {
        match event["type"].as_str().unwrap_or("") {
            "response" if event["id"] == prompt_id => {
                if event["command"] != "prompt" || event["success"] != true {
                    return Err(Error::Rejected);
                }
                if event["data"]["disposition"] != "started" {
                    return Err(Error::Protocol);
                }
                self.accepted = true;
            }
            "message_end" | "turn_end" => self.message(&event["message"]),
            "agent_end" => {
                if let Some(messages) = event["messages"].as_array() {
                    for message in messages {
                        self.message(message);
                    }
                }
            }
            "error" | "extension_error" | "auto_retry_start" => self.failed = true,
            "auto_retry_end" if event["success"] == false => self.failed = true,
            "compaction_end" if event.get("errorMessage").is_some() => self.failed = true,
            "message_update" if event["assistantMessageEvent"]["type"] == "error" => {
                self.failed = true
            }
            "agent_settled" => {
                self.settled = true;
                self.failed |= event["aborted"] == true;
            }
            _ => {}
        }
        if self.accepted && self.settled {
            if self.failed || !self.completed_message {
                return Err(Error::Model);
            }
            return Ok(true);
        }
        Ok(false)
    }

    fn message(&mut self, message: &Value) {
        if message["role"] != "assistant" {
            return;
        }
        match message["stopReason"].as_str() {
            Some("stop") => self.completed_message = true,
            Some("toolUse") => self.completed_message = false,
            Some("error" | "aborted" | "length") => self.failed = true,
            _ => self.failed = true,
        }
        self.failed |= message
            .get("errorMessage")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty());
    }
}

/// 只映射文本与工具输出，不透传配置、usage 或提供方错误记录。
pub fn acp_update(event: &Value) -> Option<Value> {
    match event["type"].as_str()? {
        "message_update" if event["assistantMessageEvent"]["type"] == "text_delta" => Some(json!({
            "sessionUpdate":"agent_message_chunk", "content":{"type":"text","text":event["assistantMessageEvent"]["delta"].as_str()?}
        })),
        kind @ ("tool_execution_start" | "tool_execution_update" | "tool_execution_end") => {
            let status = match kind {
                "tool_execution_end" if event["isError"] == true => "failed",
                "tool_execution_end" => "completed",
                _ => "in_progress",
            };
            let source = if kind == "tool_execution_update" {
                &event["partialResult"]
            } else {
                &event["result"]
            };
            let content: Vec<_> = source["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| {
                    c["text"]
                        .as_str()
                        .map(|text| json!({"type":"content","content":{"type":"text","text":text}}))
                })
                .collect();
            Some(
                json!({"sessionUpdate":if kind == "tool_execution_start" {"tool_call"} else {"tool_call_update"},
                "toolCallId":event["toolCallId"].as_str()?,"title":event["toolName"].as_str().unwrap_or("tool"),"status":status,"content":content}),
            )
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepted_and_agent_end_are_not_completion() {
        let mut turn = Turn::default();
        assert!(
            !turn
                .observe(
                    &json!({"type":"response","id":"other","success":false}),
                    "p"
                )
                .unwrap()
        );
        assert!(!turn.observe(&json!({"type":"response","id":"p","command":"prompt","success":true,"data":{"disposition":"started"}}), "p").unwrap());
        assert!(!turn.observe(&json!({"type":"agent_end","messages":[{"role":"assistant","stopReason":"stop"}]}), "p").unwrap());
        assert!(
            turn.observe(&json!({"type":"agent_settled","aborted":false}), "p")
                .unwrap()
        );
    }
    #[test]
    fn settled_before_acceptance_and_model_errors() {
        let mut turn = Turn::default();
        turn.observe(&json!({"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"SECRET"}}), "p").unwrap();
        assert!(!turn.observe(&json!({"type":"agent_settled"}), "p").unwrap());
        assert!(matches!(turn.observe(&json!({"type":"response","id":"p","command":"prompt","success":true,"data":{"disposition":"started"}}), "p"), Err(Error::Model)));
    }
    #[test]
    fn maps_tool_lifecycle() {
        let update = acp_update(&json!({"type":"tool_execution_end","toolCallId":"t","toolName":"bash","isError":true,"result":{"content":[{"type":"text","text":"output"}]}})).unwrap();
        assert_eq!(update["status"], "failed");
        assert_eq!(update["content"][0]["content"]["text"], "output");
    }
}
