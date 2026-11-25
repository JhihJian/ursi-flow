use crate::{arg, count, emit, env, result};
use serde_json::json;
use std::time::Duration;
use ursi_sandbox_client::{
    Error, Gateway, Result, Secret,
    acp::{Acp, PromptOutcome},
};

pub(super) const HELP: &str = r#"
可选 Agent 消费方：
  acp initialize
  acp new WORKSPACE_CWD
  acp prompt SESSION_ID PROMPT_TEXT_FILE
  acp status|close|cancel SESSION_ID

  URSI_SANDBOX_ID                   ACP 会话所在的沙箱 ID
  URSI_ACP_ENDPOINT                 默认 agent_session
  URSI_SESSION_TOKEN[_FILE]         Pi 会话服务的 Bearer 身份

输出：JSONL，ACP update 为通知，result 才是请求结果。
prompt 仅 end_turn 返回 0，cancelled 返回 2，错误/超时返回 1。
cancel 是通知，输出仅表示已发送。应等待原 prompt 的 cancelled 并查询 status。
断线/超时不会自动取消或重放远端任务。另一个进程可查询/取消同一会话。
"#;

pub(super) async fn run(args: &[String], timeout: Duration) -> Result<i32> {
    let operation = arg(args, 1)?;
    count(
        args,
        match operation {
            "initialize" => 2,
            "prompt" => 4,
            "new" | "cancel" | "status" | "close" => 3,
            _ => return Err(Error::Invalid("未知 ACP 命令".into())),
        },
    )?;
    let sandbox_id = env("URSI_SANDBOX_ID")?;
    let gateway = Gateway::new(
        &env("URSI_GATEWAY_URL")?,
        Secret::from_env("URSI_GATEWAY_KEY")?,
        timeout,
    )?;
    let endpoint = std::env::var("URSI_ACP_ENDPOINT").unwrap_or_else(|_| "agent_session".into());
    let bridge = gateway
        .bridge(&sandbox_id, &endpoint, "127.0.0.1:0".parse().unwrap())
        .await?;
    let address = bridge.local_addr()?;
    let (bridge_control, receiver) = tokio::sync::watch::channel(false);
    let bridge_task = tokio::spawn(bridge.run_until(receiver));
    let outcome = session(args, operation, &format!("ws://{address}/acp"), timeout).await;
    let _ = bridge_control.send(true);
    let _ = bridge_task.await;
    outcome
}

async fn session(args: &[String], operation: &str, url: &str, timeout: Duration) -> Result<i32> {
    let mut acp = if std::env::var_os("URSI_SESSION_TOKEN").is_some()
        || std::env::var_os("URSI_SESSION_TOKEN_FILE").is_some()
    {
        Acp::connect(url, Secret::from_env("URSI_SESSION_TOKEN")?, timeout).await?
    } else {
        Acp::connect_without_auth(url, timeout).await?
    };
    let initialized = acp.initialize().await?;
    if operation == "initialize" {
        result(initialized);
        return Ok(0);
    }
    let session = arg(args, 2)?;
    let (method, params) = match operation {
        "new" => ("session/new", json!({"cwd":session,"mcpServers":[]})),
        "prompt" => (
            "session/prompt",
            json!({"sessionId":session,"prompt":[{"type":"text","text":std::fs::read_to_string(arg(args, 3)?)?}]}),
        ),
        "status" => ("_ursi/session/status", json!({"sessionId":session})),
        "close" => ("_ursi/session/close", json!({"sessionId":session})),
        "cancel" => {
            acp.notify("session/cancel", json!({"sessionId":session}))
                .await?;
            result(json!({"cancelSent":true,"sessionId":session}));
            return Ok(0);
        }
        _ => unreachable!(),
    };
    let value = acp
        .request(method, params, |update| {
            emit(json!({"type":"update","params":update}))
        })
        .await?;
    let code = if operation == "prompt" {
        match PromptOutcome::from_result(&value)? {
            PromptOutcome::Completed => 0,
            PromptOutcome::Cancelled => 2,
        }
    } else {
        0
    };
    result(value);
    Ok(code)
}
