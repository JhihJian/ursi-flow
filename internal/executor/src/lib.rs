//! 执行器抽象与适配层。
//!
//! 定义统一的执行器接口，把单次过程的输入与能力配置交给具体执行器运行，
//! 并把不同 agent CLI 适配为统一协议。能力定制（提示词、模型、Skills、MCP）
//! 是角色的属性，执行器负责把这些属性渲染为该 CLI 可用的配置。

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
    /// 运行一次执行。env 由 engine 注入：sandbox 提供实现，Runner 经 domain
    /// 的 `ExecutionEnv` 契约操作环境，不感知实现是本地目录还是沙箱容器。
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
