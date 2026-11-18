//! Flow -> Runtime ACP 的真实服务核验入口。
//!
//! 该测试只核验 Runtime ACP WebSocket 与 Flow Runner，不包含 Gateway 准备、
//! SSH/SFTP、真实模型配置或产物回收。默认 ignored，并要求显式设置
//! `URSI_FLOW_REAL_ACP=1`，避免普通测试误触真实服务。

use std::sync::Arc;

use async_trait::async_trait;
use ursi_agent_runtime::{AcpRunner, EventSink, InvocationInput, Runner};
use ursi_domain::{EnvError, ExecutionEnv, Executor, ExecutorKind, Role};

struct UnusedExecutionEnv;

#[async_trait]
impl ExecutionEnv for UnusedExecutionEnv {
    async fn exec(&self, _cmd: &str) -> Result<(i32, String), EnvError> {
        Err(EnvError::Other(
            "真实 ACP 核验不使用 Flow ExecutionEnv".into(),
        ))
    }

    async fn write_file(&self, _path: &str, _content: &[u8]) -> Result<(), EnvError> {
        Err(EnvError::Other(
            "真实 ACP 核验不使用 Flow ExecutionEnv".into(),
        ))
    }

    async fn read_file(&self, _path: &str) -> Result<Vec<u8>, EnvError> {
        Err(EnvError::Other(
            "真实 ACP 核验不使用 Flow ExecutionEnv".into(),
        ))
    }
}

#[tokio::test]
#[ignore = "需要显式 URSI_FLOW_REAL_ACP=1 和运行中的 Runtime ACP 服务"]
async fn flow_runner_can_verify_real_runtime_acp() {
    assert_eq!(
        std::env::var("URSI_FLOW_REAL_ACP").as_deref(),
        Ok("1"),
        "请显式启用真实服务核验"
    );
    let runner = AcpRunner::from_env()
        .expect("ACP 配置应完整且有效")
        .expect("已启用真实 ACP 时 Runner 不应缺失");
    let role = Role {
        id: "real-acp-check".into(),
        name: "真实 ACP 核验".into(),
        prompt: "简短回答，确认 Runtime ACP 已接通。".into(),
        model: Some("runtime-profile".into()),
        skills: Vec::new(),
        mcp_servers: Vec::new(),
        executor_id: None,
    };
    let executor = Executor {
        id: "runtime-acp".into(),
        name: "Runtime ACP".into(),
        kind: ExecutorKind::Cli("runtime-acp".into()),
    };
    let input = InvocationInput {
        prompt: "只回复 ACP-OK。".into(),
        artifact_context: String::new(),
        run_id: "real-acp-check-run".into(),
        node_id: "real-acp-check-node".into(),
    };
    let sink: EventSink<'_> = &|_event| {};
    let result = runner
        .run(&input, &role, &executor, Arc::new(UnusedExecutionEnv), sink)
        .await
        .expect("Runtime ACP 应返回 end_turn");
    assert!(
        !result.output.trim().is_empty(),
        "真实 ACP 应回流至少一段文本"
    );
}
