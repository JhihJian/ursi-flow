//! agent 可控接口层。
//!
//! 定义执行输入、结果和事件契约。目标设计由服务端经 Channel 控制沙箱内
//! session-service，后者装配 CLI Adapter。当前只具备单次执行接口骨架，
//! ACP 客户端与会话取消等能力尚未实现。

use async_trait::async_trait;
use std::sync::Arc;
use ursi_domain::{Artifact, ExecutionEnv, Executor, Role, TelemetryEvent};

/// 执行器输入：提示词、上游产物上下文与运行上下文。
#[derive(Debug, Clone, Default)]
pub struct InvocationInput {
    pub prompt: String,
    pub artifact_context: String,
    pub run_id: String,
    pub node_id: String,
}

/// 执行器结果。
#[derive(Debug, Clone, Default)]
pub struct InvocationResult {
    pub output: String,
    pub artifacts: Vec<Artifact>,
    /// 本次执行消耗的 token 数。
    pub tokens: u64,
}

/// 事件上报回调：执行过程中产生的工具轨迹与日志。
pub type EventSink<'a> = &'a (dyn Fn(TelemetryEvent) + Send + Sync);

/// 执行器统一接口。
#[async_trait]
pub trait Runner: Send + Sync {
    /// 运行一次执行。环境由装配方注入，具体执行位置由实现决定。
    /// 此接口只覆盖单次执行，完整会话控制按模块规格继续实现。
    async fn run(
        &self,
        input: &InvocationInput,
        role: &Role,
        executor: &Executor,
        env: Arc<dyn ExecutionEnv>,
        sink: EventSink<'_>,
    ) -> Result<InvocationResult, ExecutorError>;
}

/// 执行器错误。
#[derive(Debug, thiserror::Error)]
pub enum ExecutorError {
    #[error("执行器启动失败：{0}")]
    Launch(String),
    #[error("执行失败：{0}")]
    Execution(String),
    #[error("解析执行器输出失败：{0}")]
    Parse(String),
}
