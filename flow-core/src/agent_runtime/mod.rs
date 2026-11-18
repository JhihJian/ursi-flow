//! 单次执行的输入、结果和能力配置契约。ACP 会话控制由 sandbox-access 实现。

pub mod capability;
#[cfg(any(test, feature = "test-support"))]
pub mod mock;
#[cfg(test)]
mod mock_tests;

use async_trait::async_trait;
use std::sync::Arc;
use crate::domain::{Artifact, ExecutionEnv, Executor, Role, TelemetryEvent};

pub use capability::{CapabilityConfig, CapabilityError};
#[cfg(any(test, feature = "test-support"))]
pub use mock::{MockRunner, MockScenario};

/// 执行器输入：提示词、上游产物上下文与运行上下文。
///
/// run_id / node_id 是一次执行的关联标识，贯穿请求、事件与结果。
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
///
/// 同步回调，弱引用语义：调用即返回，不阻塞执行，消费者缺失不阻止
/// 控制请求与结果返回。
pub type EventSink<'a> = &'a (dyn Fn(TelemetryEvent) + Send + Sync);

/// 执行器统一接口。
#[async_trait]
pub trait Runner: Send + Sync {
    /// 运行一次执行。返回时执行应已结束；如果无法确认（如连接中断），
    /// 返回 [`ExecutorError::OutcomeUnknown`]。执行环境由装配方注入。
    async fn run(
        &self,
        input: &InvocationInput,
        role: &Role,
        executor: &Executor,
        env: Arc<dyn ExecutionEnv>,
        sink: EventSink<'_>,
    ) -> Result<InvocationResult, ExecutorError>;

    /// 取消意图属于当前调用。不能中断的执行器仍须等到执行确认结束。
    async fn run_cancellable(
        &self,
        input: &InvocationInput,
        role: &Role,
        executor: &Executor,
        env: Arc<dyn ExecutionEnv>,
        sink: EventSink<'_>,
        _cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Result<InvocationResult, ExecutorError> {
        self.run(input, role, executor, env, sink).await
    }
}

/// 执行器错误。
///
/// 可 Clone：mock 场景注入与上层转发都需要复制错误值。
#[derive(Debug, Clone, thiserror::Error)]
pub enum ExecutorError {
    #[error("执行器启动失败：{0}")]
    Launch(String),
    #[error("执行失败：{0}")]
    Execution(String),
    /// 已确认不可重试，例如执行已取消或收尾失败。
    #[error("执行不可重试：{0}")]
    DoNotRetry(String),
    #[error("解析执行器输出失败：{0}")]
    Parse(String),
    #[error("执行结果未知：{0}")]
    OutcomeUnknown(String),
}
