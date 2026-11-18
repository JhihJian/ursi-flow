//! agent 可控接口层。
//!
//! 定义执行输入、结果和事件契约，以及会话控制协议。目标设计由服务端经
//! Channel 控制沙箱内 session-service，后者装配 CLI Adapter。本 crate
//! 提供：
//!
//! - 单次执行接口：[`Runner`]、[`InvocationInput`]、[`InvocationResult`]。
//! - 会话控制：[`session::SessionControl`] trait 与基于 [`session::AcpFrameTransport`]
//!   的 [`session::AcpSessionController`] 实现（session/new、session/prompt、
//!   cancel、close，JSON-RPC 自增 id 关联，事件经 sink 回流）。
//! - 能力配置契约：[`capability::CapabilityConfig`]（prompt、model、skills、
//!   mcp_servers），未知能力字段返回明确错误。
//! - 确定性测试替身：[`mock::MockRunner`]。
//!
//! 连接中断与任务失败可区分（[`session::SessionError`]），未知结果的任务
//! 不自动重复提交；工作流重试策略由 server engine 决定。

pub mod capability;
pub mod mock;
pub mod session;
pub mod websocket;

use async_trait::async_trait;
use std::sync::Arc;
use ursi_domain::{Artifact, ExecutionEnv, Executor, Role, TelemetryEvent};

pub use capability::{CapabilityConfig, CapabilityError};
pub use mock::{MockRunner, MockScenario};
pub use session::{
    AcpEvent, AcpFrameTransport, AcpSessionController, ExecutionState, SessionControl,
    SessionError, SessionHandle, SessionSpec, map_acp_event_to_telemetry, stop_reason_to_state,
};
pub use websocket::{AcpRunner, WebSocketAcpConfig, WebSocketSessionController};

/// Flow 角色显式选择 Runtime ACP 的执行器类型。
pub const RUNTIME_ACP: &str = "runtime-acp";
/// 角色使用管理员固定的模型，而非请求模型覆盖。
pub const RUNTIME_PROFILE: &str = "runtime-profile";

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
    /// 运行一次执行。环境由装配方注入，具体执行位置由实现决定。
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
///
/// 可 Clone：mock 场景注入与上层转发都需要复制错误值。
#[derive(Debug, Clone, thiserror::Error)]
pub enum ExecutorError {
    #[error("执行器启动失败：{0}")]
    Launch(String),
    #[error("执行失败：{0}")]
    Execution(String),
    /// prompt 结果未知、已取消或已完成但收尾失败。调用方不得重新提交。
    #[error("执行不可重试：{0}")]
    DoNotRetry(String),
    #[error("解析执行器输出失败：{0}")]
    Parse(String),
}
