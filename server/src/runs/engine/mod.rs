//! 流程执行引擎。
//!
//! 把一次运行从工作流定义实例化，按拓扑顺序调度节点执行，管理状态机流转、
//! 人工审批与打回、失败重试与终态。所有状态变更经 [`RunRepository::commit_run`]
//! （持有代数 CAS）原子提交成功后再经 [`EventBus`] 广播；先 commit 后 emit，
//! 顺序不可颠倒（DESIGN「一致性归属」：广播是实时通知，数据库事件是历史
//! 重放的事实来源）。
//!
//! 调度模型：同一引擎内每次运行只有一个调度者。启动、放行和打回取得
//! 调度权和租约后，由独立于请求的任务驱动到终态或审批挂起。取消通知
//! 活动调度者停止推进；只有确认执行结束后才提交取消终态。所有提交以
//! 租约代数做 CAS，旧持有者的提交不能覆盖接管后的结果。
//!
//! 第二阶段已落实：
//! - 角色冻结配置：agent 执行时从存储快照解析冻结的
//!   [`ursi_domain::Role`]（提示词、模型、skills、MCP、执行器标识）传给
//!   Runner；提示词用节点输入语义（节点名 + 当前轮次上游产物上下文），
//!   角色提示词由 Runner 契约承载；
//! - 产物归属与契约：必需产物契约检查先于归属落库，缺失即节点失败；
//!   成功后按声明归 (run, node, generation, attempt) 写入归属表；
//! - 取消（[`Engine::cancel`]）：停止新调度、处置活动执行、置取消终态；
//!   Runner 契约本版无中断入口，活动执行等待完成后处置（见入口文档）；
//! - 恢复（[`Engine::start_run`] 接管 + 结果核实）：重启后新 Engine 实例
//!   同一存储接管过期租约的运行，running 残留节点先按结果未知核实留档
//!   再重新调度（attempt 递增，不重复提交同一 attempt）；
//! - 资源收尾（[`Engine::release_resources`]）：终态后经注入的
//!   [`ResourceReleaser`] 释放，清理状态持久化可查询重试；
//! - 沙箱脚本执行：[`ScriptExecutor`] 注入实现，真实沙箱执行后续阶段接
//!   channel。

mod driver;
mod events;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use ursi_agent_runtime::{EventSink, InvocationInput, Runner};
use ursi_domain::{
    EventCategory, EventPhase, ExecutionEnv, NodeRun, NodeStatus, Run, RunStatus, TelemetryEvent,
    WorkflowDefinition, WorkflowNode, validate_workflow,
};

use crate::runs::{CleanupState, FrozenRole, FrozenRoles, ResourceReleaser, RunRepository};
use driver::{ActiveDriver, DriverGuard, Drivers};
pub use crate::runs::{LeaseError, LeaseState, LeaseTable};

pub use events::EventBus;

/// 恢复时对结果未知执行的处置语义（SPEC「恢复时对结果未知的执行先查询或
/// 核实，不直接重复提交任务」）。本版取值唯一，枚举保留语义命名供文档
/// 与后续策略扩展（如远端任务查询核实后复用原 attempt）。
/// 默认执行路径使用 [`UnknownOutcomeResolution::MarkUnknownAndReschedule`]；
/// Runtime ACP 无法核实残留会话时保留 running 并返回结果未知。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnknownOutcomeResolution {
    /// 本版语义：标记该 attempt 结果未知，按「执行结果核实」事件留档，
    /// 节点重置到 pending 重新调度，attempt 继续递增（不重复提交同一
    /// attempt；同一任务重复提交由外部执行器幂等性在联调时防护）。
    MarkUnknownAndReschedule,
}

/// 取消时活动执行的处置语义（SPEC「取消后不启动下游，只有确认执行停止
/// 后才报告取消完成；连接中断与任务失败可区分」）。
///
/// Runner 无中断入口，取消等待当前执行确认结束，不再采纳该节点的结果或
/// 推进下游。结果未知时保留可恢复状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveCancellationPolicy {
    WaitForActiveCompletion,
}

/// 脚本执行器接口：本阶段注入替身，真实沙箱执行后续阶段接 channel。
#[async_trait]
pub trait ScriptExecutor: Send + Sync {
    /// 执行脚本，返回输出。无法确认执行已停止时返回 `OutcomeUnknown`。
    async fn exec(&self, script: &str, language: &str) -> Result<String, ScriptExecutionError>;
}

/// 脚本执行错误。
#[derive(Debug, thiserror::Error)]
pub enum ScriptExecutionError {
    #[error("脚本执行失败：{0}")]
    Failed(String),
    #[error("不支持的语言：{0}")]
    UnsupportedLanguage(String),
    #[error("脚本执行结果未知：{0}")]
    OutcomeUnknown(String),
}

/// 流程执行引擎：编排调度、状态机、人工审批、重试与事件广播。
#[derive(Clone)]
pub struct Engine {
    drivers: Arc<Drivers>,
    store: Arc<dyn RunRepository>,
    runner: Arc<dyn Runner>,
    runtime_acp: Option<Arc<dyn Runner>>,
    events: Arc<EventBus>,
    leases: Arc<dyn LeaseTable>,
    script_executor: Arc<dyn ScriptExecutor>,
    /// Runner 调用时的环境（后续阶段随角色冻结配置装配沙箱环境）。
    env: Arc<dyn ExecutionEnv>,
    /// 资源释放入口：run 终态后 release_resources 调用（未装配则报错）。
    releaser: Option<Arc<dyn ResourceReleaser>>,
    /// 租约 TTL（毫秒）。测试注入小值配合可控时钟。
    lease_ttl_ms: u64,
    holder: String,
}

impl Engine {
    /// 装配引擎所需依赖。
    pub fn new(
        store: Arc<dyn RunRepository>,
        runner: Arc<dyn Runner>,
        events: Arc<EventBus>,
        leases: Arc<dyn LeaseTable>,
        script_executor: Arc<dyn ScriptExecutor>,
    ) -> Self {
        Self {
            drivers: Arc::new(Drivers::default()),
            store,
            runner,
            runtime_acp: None,
            events,
            leases,
            script_executor,
            releaser: None,
            env: Arc::new(PlaceholderEnv),
            lease_ttl_ms: 300_000,
            holder: format!("engine-{}", uuid::Uuid::new_v4().simple()),
        }
    }

    /// 仅供快照明确选择 runtime-acp 的节点调用。
    pub(crate) fn with_runtime_acp(mut self, runner: Option<Arc<dyn Runner>>) -> Self {
        self.runtime_acp = runner;
        self
    }

    /// 注入执行环境（后续阶段随角色冻结配置装配沙箱环境）。
    pub fn with_env(mut self, env: Arc<dyn ExecutionEnv>) -> Self {
        self.env = env;
        self
    }

    /// 注入资源释放器：release_resources 必需。
    pub fn with_releaser(mut self, releaser: Arc<dyn ResourceReleaser>) -> Self {
        self.releaser = Some(releaser);
        self
    }

    /// 设置租约 TTL（毫秒）。
    pub fn with_lease_ttl_ms(mut self, ttl_ms: u64) -> Self {
        self.lease_ttl_ms = ttl_ms;
        self
    }

    /// 广播一条已持久化的运行事件，调用方负责先完成状态与事件提交。
    pub fn emit_event(&self, run_id: &str, event: TelemetryEvent) {
        self.events.emit(run_id, event);
    }

    /// 订阅运行事件流。
    pub fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<(String, TelemetryEvent)> {
        self.events.subscribe()
    }

    /// 从工作流定义创建一次运行，冻结工作流快照与角色配置。
    ///
    /// 校验定义 → 生成 run id → 快照冻结 workflow 与 frozen_config（角色
    /// 能力、执行器标识；SPEC「运行创建与配置冻结」）→ 初始化节点全
    /// pending → generation=1 → status=queued → 入库。校验失败不产生运行。
    /// 与配置域的一致读取联合（经各域接口读取后传入 frozen_config）是
    /// 联合验收边界，engine 只保证快照一致性语义。
    pub async fn create_run(
        &self,
        wf: &WorkflowDefinition,
        frozen_config: &FrozenRoles,
    ) -> Result<Run, EngineError> {
        validate_workflow(wf).map_err(EngineError::InvalidDefinition)?;
        // 快照完整性校验（SPEC「运行创建与配置冻结」：缺失角色或不支持的
        // 执行能力使创建失败，不产生可启动的半成品运行）：agent 节点引用
        // 的角色必须在冻结集合中，且可解析为 domain Role。
        for node in &wf.nodes {
            if node.node_type != ursi_domain::NodeType::Agent {
                continue;
            }
            let role_id = node.role_id.as_deref().unwrap_or("");
            let value = frozen_config.get(role_id).ok_or_else(|| {
                EngineError::FrozenRoleMissing {
                    run_id: "（创建校验）".to_string(),
                    role_id: role_id.to_string(),
                }
            })?;
            let _: FrozenRole = serde_json::from_value(value.clone())
                .map_err(|e| EngineError::FrozenRoleInvalid {
                    role_id: role_id.to_string(),
                    reason: e.to_string(),
                })?;
        }
        let run = Run {
            id: format!("run-{}", uuid::Uuid::new_v4().simple()),
            workflow: wf.clone(),
            status: RunStatus::Queued,
            nodes: wf
                .nodes
                .iter()
                .map(|n| NodeRun {
                    node_id: n.id.clone(),
                    status: NodeStatus::Pending,
                    output: None,
                    error: None,
                    attempts: 0,
                    reworks: 0,
                })
                .collect(),
            generation: 1,
        };
        self.store.create_run(&run, frozen_config).await?;
        Ok(run)
    }

    /// 启动运行：获取租约 → 按拓扑顺序调度就绪节点直到终态或审批挂起。
    ///
    /// 重启后（新 Engine 实例同一存储）对 queued / running 且租约可接管的
    /// 运行同样适用：恢复沿用快照，恢复时对 running 节点先核实结果
    /// （见 [`Engine::reconcile_interrupted`]），再继续调度。
    pub async fn start_run(&self, run_id: &str) -> Result<(), EngineError> {
        let driver = self.claim_driver(run_id)?;
        let generation = self.acquire(run_id).await?;
        let mut run = self.load(run_id).await?;
        run.generation = generation;
        self.spawn_driver(driver, run, generation).await
    }

    /// 恢复入口：接管存储中非终态且租约已过期的运行并继续调度。
    ///
    /// 重启后（新 Engine 实例同一存储）调用：对每个候选运行先核实结果未知的
    /// running 节点（不直接重复提交任务），再继续调度，直到终态或审批挂起。
    /// 返回接管的运行 id 列表（按传入顺序，失败者跳过并在错误中带出）。
    ///
    /// 快照恢复语义：运行定义、冻结角色与节点状态全部来自存储，engine 不
    /// 内存重建（SPEC「使用可控时钟模拟租约到期，重开存储后可接管，恢复
    /// 沿用快照」）。
    pub async fn resume_interrupted(
        &self,
        run_ids: &[String],
    ) -> Vec<(String, Result<(), EngineError>)> {
        let mut outcomes = Vec::new();
        for run_id in run_ids {
            outcomes.push((run_id.clone(), self.start_run(run_id).await));
        }
        outcomes
    }

    /// 通知活动调度者取消，并等待已提交的取消终态。无活动调度者时，
    /// 只允许取消没有未确认执行的运行。
    pub async fn cancel(&self, run_id: &str) -> Result<(), EngineError> {
        let _driver = match self.drivers.claim(run_id) {
            Ok(driver) => driver,
            Err(active) => {
                active.request_cancel_and_wait().await;
                let run = self.load(run_id).await?;
                return if run.status == RunStatus::Cancelled {
                    Ok(())
                } else {
                    Err(EngineError::StateConflict(format!(
                        "未能确认取消（当前状态 {}）",
                        run.status.as_str()
                    )))
                };
            }
        };
        let run = self.load(run_id).await?;
        Self::check_cancellable(&run, None)?;
        let generation = self.acquire(run_id).await?;
        let mut run = self.load(run_id).await?;
        run.generation = generation;
        self.commit_cancelled(&mut run, generation, None, Vec::new()).await
    }

    /// 资源收尾：运行终态后释放沙箱、会话等关联资源。
    ///
    /// 调用注入的 [`ResourceReleaser`]，结果持久化为独立清理状态
    /// （pending → done / failed）：失败可查询错误并重试；运行执行结果
    /// 不受清理结果影响（SPEC「资源释放失败时运行执行结果保留」）。非
    /// 终态运行拒绝收尾。清理结果未知导致的失败重试由调用方再次调用本
    /// 入口完成（幂等性由真实 Gateway 联调保证，DESIGN「资源与会话」）。
    pub async fn release_resources(
        &self,
        run_id: &str,
    ) -> Result<crate::runs::CleanupStatus, EngineError> {
        let releaser = self
            .releaser
            .as_ref()
            .ok_or_else(|| EngineError::ReleaserNotConfigured)?;
        let run = self.load(run_id).await?;
        if !matches!(
            run.status,
            RunStatus::Succeeded | RunStatus::Failed | RunStatus::Cancelled
        ) {
            return Err(EngineError::StateConflict(format!(
                "运行非终态（{}），不能释放资源",
                run.status.as_str()
            )));
        }
        self.store
            .set_cleanup_status(run_id, CleanupState::Pending, None)
            .await?;
        match releaser.release(run_id).await {
            Ok(()) => {
                self.store
                    .set_cleanup_status(run_id, CleanupState::Done, None)
                    .await?;
            }
            Err(err) => {
                self.store
                    .set_cleanup_status(run_id, CleanupState::Failed, Some(&err.to_string()))
                    .await?;
            }
        }
        Ok(self
            .store
            .cleanup_status(run_id)
            .await?
            .expect("刚写入的清理状态可读回"))
    }

    /// 恢复前核实：把中断时处于 running 的节点处置为可安全重新调度的
    /// 状态。执行结果未知时，按核实事件留档并重置 pending（attempt 在
    /// 下次调度时继续递增，不重复提交同一 attempt）。
    ///
    /// 本地有完成记录（succeeded/failed）或等待审批的节点不动。
    async fn reconcile_interrupted(
        this: &Self,
        run: &mut Run,
        generation: u64,
    ) -> Result<(), EngineError> {
        let running: Vec<String> = run
            .nodes
            .iter()
            .filter(|n| n.status == NodeStatus::Running)
            .map(|n| n.node_id.clone())
            .collect();
        if running.is_empty() {
            return Ok(());
        }
        let mut events = Vec::new();
        for node_id in &running {
            if let Some(spec) = run.workflow.nodes.iter().find(|n| &n.id == node_id && n.node_type == ursi_domain::NodeType::Agent) {
                let role = this.frozen_role(&run.id, spec.role_id.as_deref()).await?;
                if role.executor_kind.as_ref().map(|kind| kind.as_str()) == Some(ursi_agent_runtime::RUNTIME_ACP) {
                    // 没有持久化的 ACP 会话句柄，不能以新的 attempt 重放 prompt。
                    return Err(EngineError::OutcomeUnknown(format!("节点 {node_id} 的 runtime-acp 执行尚未核实")));
                }
            }
            let node = node_mut(run, node_id)?;
            let unknown_attempt = node.attempts;
            node.status = NodeStatus::Pending;
            node.error = Some(format!(
                "执行结果未知（重启中断，attempt {unknown_attempt}），已核实并重新调度"
            ));
            events.push(node_event(
                run,
                node_id,
                "node.outcome_unverified",
                format!("执行结果核实：attempt {unknown_attempt} 结果未知，重新调度"),
                EventPhase::Progress,
            ));
        }
        let () = this.commit_and_emit(run, generation, events).await?;
        Ok(())
    }

    /// 审批放行：让等待审批的节点继续，推进下游。
    /// 终态运行（succeeded/failed/cancelled）拒绝操作，状态不变。
    pub async fn approve(&self, run_id: &str, node_id: &str) -> Result<(), EngineError> {
        let driver = self.claim_driver(run_id)?;
        let generation = self.acquire(run_id).await?;
        let mut run = self.load(run_id).await?;
        run.generation = generation;
        if matches!(
            run.status,
            RunStatus::Succeeded | RunStatus::Failed | RunStatus::Cancelled
        ) {
            return Err(EngineError::StateConflict(format!(
                "运行已是终态（{}），不能放行",
                run.status.as_str()
            )));
        }
        {
            let node = node_mut(&mut run, node_id)?;
            if node.status != NodeStatus::WaitingApproval {
                return Err(EngineError::StateConflict(format!(
                    "节点 {node_id} 不在等待审批状态（当前 {}），不能放行",
                    node.status.as_str()
                )));
            }
            node.status = NodeStatus::Succeeded;
            node.output = Some("已审批放行".to_string());
            node.error = None;
        }
        self.spawn_driver(driver, run, generation).await
    }

    /// 审批打回：把运行重置到目标环节重新执行。
    ///
    /// target 必须是审批节点的传递祖先且审批节点当前 waiting，否则返回
    /// 状态冲突且状态不变；合法打回时 target 及其全部下游重置 pending、
    /// target reworks+1，从 target 重新调度。旧输出不自动成为新轮次输出；
    /// attempts / reworks 累计保留（执行编号单调递增不复用）。
    /// 终态运行（succeeded/failed/cancelled）拒绝打回，状态不变。
    pub async fn reject(
        &self,
        run_id: &str,
        node_id: &str,
        target_node_id: &str,
    ) -> Result<(), EngineError> {
        let driver = self.claim_driver(run_id)?;
        let generation = self.acquire(run_id).await?;
        let mut run = self.load(run_id).await?;
        run.generation = generation;
        if matches!(
            run.status,
            RunStatus::Succeeded | RunStatus::Failed | RunStatus::Cancelled
        ) {
            return Err(EngineError::StateConflict(format!(
                "运行已是终态（{}），不能打回",
                run.status.as_str()
            )));
        }

        {
            let node = node_of(&run, node_id)?;
            if node.status != NodeStatus::WaitingApproval {
                return Err(EngineError::StateConflict(format!(
                    "节点 {node_id} 不在等待审批状态（当前 {}），不能打回",
                    node.status.as_str()
                )));
            }
            // 打回目标必须是传递祖先；自身与非祖先都拒绝。
            if target_node_id == node_id
                || !ancestors_of(&run.workflow, node_id).contains(target_node_id)
            {
                return Err(EngineError::StateConflict(format!(
                    "打回目标 {target_node_id} 不是 {node_id} 的传递祖先"
                )));
            }
        }

        // 打回次数限制（SPEC「返工受 MaxReworks 限制」）：目标节点累计
        // 返工次数达到声明上限后不再接受打回，进入明确失败终态。
        {
            let (max_reworks, reworks_done) = {
                let target_spec = run
                    .workflow
                    .nodes
                    .iter()
                    .find(|n| n.id == target_node_id)
                    .ok_or_else(|| {
                        EngineError::NodeNotFound(run.id.clone(), target_node_id.to_string())
                    })?;
                let target_node = node_of(&run, target_node_id)?;
                (target_spec.max_reworks, target_node.reworks)
            };
            if max_reworks > 0 && reworks_done >= max_reworks {
                {
                    let node = node_mut(&mut run, target_node_id)?;
                    node.status = NodeStatus::Failed;
                    node.error = Some(format!(
                        "返工次数达到上限（{reworks_done} / {max_reworks}），打回被拒绝，运行终止"
                    ));
                }
                run.status = RunStatus::Failed;
                let terminal_event = lifecycle_event(&run, "run.failed", "返工达到上限，运行终止");
                self.commit_and_emit(&mut run, generation, vec![terminal_event])
                    .await?;
                return Ok(());
            }
        }

        let descendants = descendants_of(&run.workflow, target_node_id);
        for node in run.nodes.iter_mut() {
            if node.node_id == target_node_id {
                node.status = NodeStatus::Pending;
                node.output = None;
                node.error = None;
                node.reworks += 1;
            } else if descendants.contains(&node.node_id) {
                // 下游重置为新轮次起点；attempts 累计保留。
                node.status = NodeStatus::Pending;
                node.output = None;
                node.error = None;
            }
        }
        run.status = RunStatus::Running;
        self.spawn_driver(driver, run, generation).await
    }
}

impl Engine {
    fn claim_driver(&self, run_id: &str) -> Result<DriverGuard, EngineError> {
        self.drivers.claim(run_id).map_err(|_| {
            EngineError::StateConflict(format!("运行 {run_id} 已有活动调度者"))
        })
    }

    async fn spawn_driver(
        &self,
        driver: DriverGuard,
        mut run: Run,
        generation: u64,
    ) -> Result<(), EngineError> {
        let engine = self.clone();
        // 请求断开只放弃等待结果。调度和所有权仍保留到活动执行结束。
        tokio::spawn(async move { engine.drive(&mut run, generation, &driver.active).await })
            .await
            .map_err(EngineError::DriverTask)?
    }

    fn check_cancellable(run: &Run, stopped_node: Option<&str>) -> Result<(), EngineError> {
        if matches!(run.status, RunStatus::Succeeded | RunStatus::Failed | RunStatus::Cancelled) {
            return Err(EngineError::StateConflict(format!(
                "运行已是终态（{}），不能取消",
                run.status.as_str()
            )));
        }
        if run.nodes.iter().any(|node| {
            node.status == NodeStatus::Running && Some(node.node_id.as_str()) != stopped_node
        }) {
            return Err(EngineError::StateConflict("无法确认活动执行已停止".into()));
        }
        Ok(())
    }

    async fn commit_cancelled(
        &self,
        run: &mut Run,
        generation: u64,
        stopped_node: Option<&str>,
        mut events: Vec<TelemetryEvent>,
    ) -> Result<(), EngineError> {
        Self::check_cancellable(run, stopped_node)?;
        if let Some(node_id) = stopped_node {
            node_mut(run, node_id)?.status = NodeStatus::Cancelled;
            events.push(node_event(
                run,
                node_id,
                "node.cancelled",
                "运行取消，执行确认停止",
                EventPhase::Finish,
            ));
        }
        run.status = RunStatus::Cancelled;
        events.push(lifecycle_event(run, "run.cancelled", "运行已取消，停止新调度"));
        self.commit_and_emit(run, generation, events).await
    }
    /// 获取运行租约，返回本次持有的代数。
    async fn acquire(&self, run_id: &str) -> Result<u64, EngineError> {
        Ok(self
            .leases
            .acquire_lease(run_id, &self.holder, self.lease_ttl_ms)
            .await?)
    }

    /// 加载运行；不存在返回 RunNotFound。
    async fn load(&self, run_id: &str) -> Result<Run, EngineError> {
        self.store
            .get_run(run_id)
            .await?
            .ok_or_else(|| EngineError::RunNotFound(run_id.to_string()))
    }

    /// 调度主循环：从当前运行状态出发，逐个执行就绪节点直到终态或审批
    /// 挂起。失败终态后不调度新节点。
    async fn drive(
        &self,
        run: &mut Run,
        generation: u64,
        driver: &ActiveDriver,
    ) -> Result<(), EngineError> {
        let wf = run.workflow.clone();
        if matches!(
            run.status,
            RunStatus::Succeeded | RunStatus::Failed | RunStatus::Cancelled
        ) {
            return Ok(());
        }
        if driver.cancel_requested() {
            return self.commit_cancelled(run, generation, None, Vec::new()).await;
        }
        // 进入调度即标记 running（queued 首次启动或 waiting 恢复），
        // 同事务写入启动事件，可观测。
        if run.status != RunStatus::Running {
            let resumed = run.status == RunStatus::Waiting;
            run.status = RunStatus::Running;
            let (name, message) = if resumed {
                ("run.resumed", "运行恢复调度")
            } else {
                ("run.started", "运行开始调度")
            };
            self.commit_and_emit(run, generation, vec![lifecycle_event(run, name, message)])
                .await?;
        }
        // 恢复核实：载入后仍处于 running 的节点是中断残留（正常调度路径
        // 下 drive 返回前不会留 running 节点），先核实再调度。
        if driver.cancel_requested() {
            return self.commit_cancelled(run, generation, None, Vec::new()).await;
        }
        Self::reconcile_interrupted(self, run, generation).await?;
        loop {
            if matches!(
                run.status,
                RunStatus::Succeeded | RunStatus::Failed | RunStatus::Cancelled
            ) {
                return Ok(());
            }
            if driver.cancel_requested() {
                return self.commit_cancelled(run, generation, None, Vec::new()).await;
            }
            // 安全网：载入的运行已含失败节点（如恢复场景）时直接终态。
            if run.nodes.iter().any(|n| n.status == NodeStatus::Failed) {
                run.status = RunStatus::Failed;
                self.commit_and_emit(
                    run,
                    generation,
                    vec![lifecycle_event(run, "run.failed", "节点失败，运行终止")],
                )
                .await?;
                return Ok(());
            }

            let next_id = ready_node(&wf, run);
            let Some(node_id) = next_id else {
                // 无就绪节点：全部完成则成功，否则挂起等待（审批）。
                if run.nodes.iter().all(|n| n.status == NodeStatus::Succeeded) {
                    run.status = RunStatus::Succeeded;
                    self.commit_and_emit(
                        run,
                        generation,
                        vec![lifecycle_event(run, "run.succeeded", "运行成功完成")],
                    )
                    .await?;
                } else {
                    run.status = RunStatus::Waiting;
                    self.commit_and_emit(
                        run,
                        generation,
                        vec![lifecycle_event(run, "run.waiting", "运行等待审批")],
                    )
                    .await?;
                }
                return Ok(());
            };

            if self
                .execute_node(run, &wf, &node_id, generation, driver)
                .await?
                .is_waiting_approval()
            {
                if driver.cancel_requested() {
                    return self.commit_cancelled(run, generation, None, Vec::new()).await;
                }
                return Ok(());
            }
        }
    }

    /// 执行单个节点：置 running 提交 → 调用执行体 → 按结果落状态。
    /// attempt 编号在此单调递增，同一轮次内重试不复用。
    async fn execute_node(
        &self,
        run: &mut Run,
        wf: &WorkflowDefinition,
        node_id: &str,
        generation: u64,
        driver: &ActiveDriver,
    ) -> Result<NodeOutcome, EngineError> {
        let spec = wf
            .nodes
            .iter()
            .find(|n| n.id == node_id)
            .ok_or_else(|| EngineError::NodeNotFound(run.id.clone(), node_id.to_string()))?
            .clone();

        // 置 running 并提交，之后才发起执行（状态先行，可观测）。
        {
            let node = node_mut(run, node_id)?;
            node.status = NodeStatus::Running;
            node.attempts += 1;
        }
        self.commit_and_emit(
            run,
            generation,
            vec![node_event(run, node_id, "node.started", "开始执行", EventPhase::Start)],
        )
        .await?;

        // 执行体回流的事件收集后随结果状态同事务提交，提交后再广播，
        // 保证存储与广播是同一记录身份。
        let attempt_before = node_of(run, node_id)?.attempts;
        let runner_events = Mutex::new(Vec::new());
        if driver.cancel_requested() {
            self.commit_cancelled(run, generation, Some(node_id), Vec::new()).await?;
            return Ok(NodeOutcome::Completed);
        }
        let (invocation, result_artifacts) = self
            .keep_lease(&run.id, self.invoke(&spec, run, node_id, &runner_events))
            .await?;
        let runner_events = runner_events.into_inner().expect("事件收集互斥锁可用");
        match &invocation {
            Err(NodeInvocationError::Runner(ursi_agent_runtime::ExecutorError::OutcomeUnknown(reason)))
            | Err(NodeInvocationError::Script(ScriptExecutionError::OutcomeUnknown(reason))) => {
                // 断线等未知结果既不能确认取消，也不能当普通失败重试。
                return Err(EngineError::OutcomeUnknown(reason.clone()));
            }
            _ => {}
        }
        if driver.cancel_requested() {
            self.commit_cancelled(run, generation, Some(node_id), runner_events).await?;
            return Ok(NodeOutcome::Completed);
        }
        let result_artifacts = result_artifacts.unwrap_or_default();

        // 迟到防护（SPEC「在同一持有代数内返工后，旧 attempt 的迟到状态、
        // 事件或产物不能覆盖当前执行结果」）：提交前重读节点，执行发起时
        // 的 attempt 与当前 attempt 不一致，说明执行期间发生返工，本结果
        // 属于旧 attempt，被忽略且不产生任何事件。
        let attempt_now = node_of(run, node_id)?.attempts;
        if attempt_now != attempt_before {
            return Err(EngineError::LateAttemptDiscarded {
                run_id: run.id.clone(),
                node_id: node_id.to_string(),
                stale_attempt: attempt_before,
                current_attempt: attempt_now,
            });
        }

        match invocation {
            Ok(output) => {
                // 产物契约检查（SPEC「给定声明的必需产物缺失，节点失败，
                // 下游不执行」）：执行器返回的产物必须满足节点必需声明，
                // 否则按节点失败处理（计入重试/终态路径）。
                if let Err(contract_err) = ursi_domain::check_artifact_contract(
                    &spec.artifact_outputs,
                    &result_artifacts,
                ) {
                    {
                        let node = node_mut(run, node_id)?;
                        node.status = NodeStatus::Failed;
                        node.output = None;
                        node.error = Some(contract_err.to_string());
                    }
                    run.status = RunStatus::Failed;
                    let mut events = runner_events;
                    events.push(node_event(
                        run,
                        node_id,
                        "node.failed",
                        format!("产物契约检查失败：{contract_err}"),
                        EventPhase::Finish,
                    ));
                    events.push(lifecycle_event(run, "run.failed", "必需产物缺失，运行终止"));
                    self.commit_and_emit(run, generation, events).await?;
                    return Ok(NodeOutcome::Completed);
                }
                {
                    let node = node_mut(run, node_id)?;
                    node.status = NodeStatus::Succeeded;
                    node.output = Some(output.clone());
                    node.error = None;
                }
                // 产物归属：按节点声明构造归属记录，归当前执行身份
                // （generation、attempt）。返工后新 attempt 的记录与旧
                // 记录并存，旧产物不自动成为新轮输出（联调点：artifacts
                // 域内容存取见 SPEC「查询、事件与资源收尾」）。
                self.store
                    .record_node_artifacts(
                        &run.id,
                        node_id,
                        generation,
                        attempt_before,
                        &spec.artifact_outputs,
                    )
                    .await?;
                // 输出随事件属性留档，历史轮次输出可从 events 区分。
                let mut success = node_event(run, node_id, "node.succeeded", "执行成功", EventPhase::Finish);
                success.attributes.insert(
                    "output".to_string(),
                    serde_json::Value::String(output),
                );
                if !spec.artifact_outputs.is_empty() {
                    success.attributes.insert(
                        "artifacts".to_string(),
                        serde_json::to_value(&spec.artifact_outputs)
                            .expect("产物声明序列化"),
                    );
                }
                let mut events = runner_events;
                events.push(success);
                self.commit_and_emit(run, generation, events).await?;
                Ok(NodeOutcome::Completed)
            }
            Err(NodeInvocationError::ApprovalRequested) => {
                {
                    let node = node_mut(run, node_id)?;
                    node.status = NodeStatus::WaitingApproval;
                }
                run.status = RunStatus::Waiting;
                let mut events = runner_events;
                events.push(node_event(
                    run,
                    node_id,
                    "node.waiting_approval",
                    "等待审批",
                    EventPhase::Wait,
                ));
                events.push(lifecycle_event(run, "run.waiting", "运行等待审批"));
                self.commit_and_emit(run, generation, events).await?;
                Ok(NodeOutcome::WaitingApproval)
            }
            Err(err) => {
                let retryable = !matches!(err, NodeInvocationError::Runner(
                    ursi_agent_runtime::ExecutorError::DoNotRetry(_)
                )) && node_of(run, node_id)?.attempts < spec.max_attempts;
                if retryable {
                    // 同一轮次内重试：状态回到 pending 等待再次调度。
                    let node = node_mut(run, node_id)?;
                    node.status = NodeStatus::Pending;
                    node.error = Some(err.to_string());
                    let attempts = node_of(run, node_id)?.attempts;
                    let mut events = runner_events;
                    events.push(node_event(
                        run,
                        node_id,
                        "node.failed",
                        format!("执行失败，准备重试（{attempts} / {}）：{err}", spec.max_attempts),
                        EventPhase::Progress,
                    ));
                    self.commit_and_emit(run, generation, events).await?;
                } else {
                    // 不可重试或已到上限：节点 failed 且运行进入失败终态，
                    // 终态后不调度新节点。
                    {
                        let node = node_mut(run, node_id)?;
                        node.status = NodeStatus::Failed;
                        node.error = Some(err.to_string());
                    }
                    run.status = RunStatus::Failed;
                    let mut events = runner_events;
                    events.push(node_event(
                        run,
                        node_id,
                        "node.failed",
                        format!("执行失败，不再重试：{err}"),
                        EventPhase::Finish,
                    ));
                    events.push(lifecycle_event(run, "run.failed", "节点失败，运行终止"));
                    self.commit_and_emit(run, generation, events).await?;
                }
                Ok(NodeOutcome::Completed)
            }
        }
    }

    /// 执行期间定期续约。失去租约也要等执行返回，不以丢弃 future 代替停止。
    async fn keep_lease<T>(
        &self,
        run_id: &str,
        operation: impl std::future::Future<Output = T>,
    ) -> Result<T, EngineError> {
        let period = std::time::Duration::from_millis((self.lease_ttl_ms / 3).max(1));
        tokio::pin!(operation);
        loop {
            tokio::select! {
                result = &mut operation => return Ok(result),
                _ = tokio::time::sleep(period) => {
                    if let Err(err) = self.leases.renew_lease(run_id, &self.holder, self.lease_ttl_ms).await {
                        operation.await;
                        return Err(err.into());
                    }
                }
            }
        }
    }

    /// 调用执行体：agent 走 Runner（MockRunner 等注入），script 走注入的
    /// ScriptExecutor，approval 落等待审批。
    ///
    /// Runner 回流的事件写入 `runner_events`，由调用方随状态提交。
    async fn invoke(
        &self,
        spec: &WorkflowNode,
        run: &Run,
        node_id: &str,
        runner_events: &Mutex<Vec<TelemetryEvent>>,
    ) -> (
        Result<String, NodeInvocationError>,
        Option<Vec<ursi_domain::Artifact>>,
    ) {
        match spec.node_type {
            ursi_domain::NodeType::Agent => {
                // 提示词用节点输入语义：上游产物上下文（仅当前有效轮次）
                // + 节点自身上下文；角色提示词经冻结的 Role 由 Runner 契约
                // 承载（SPEC「顺序执行与输入交接」）。
                let prompt = format!("{}（节点 {}）", spec.name, spec.id);
                // 冻结角色解析：执行身份必须来自快照，创建后编辑角色配置
                // 不影响在途运行（SPEC「运行创建与配置冻结」）。缺失即快照
                // 不完整，明确失败不猜测。
                let FrozenRole { role, executor_kind } = match self
                    .frozen_role(&run.id, spec.role_id.as_deref())
                    .await
                {
                    Ok(frozen) => frozen,
                    Err(err) => return (Err(NodeInvocationError::Frozen(err)), None),
                };
                let executor = ursi_domain::Executor {
                    id: role
                        .executor_id
                        .clone()
                        .unwrap_or_else(|| role.id.clone()),
                    name: format!("冻结执行器（{}）", role.id),
                    kind: executor_kind.unwrap_or(ursi_domain::ExecutorKind::Mock),
                };
                let input = InvocationInput {
                    prompt,
                    artifact_context: current_round_artifact_context(run, node_id),
                    run_id: run.id.clone(),
                    node_id: node_id.to_string(),
                };
                let sink: EventSink<'_> = &|event: TelemetryEvent| {
                    runner_events.lock().expect("事件收集互斥锁可用").push(event);
                };
                let runner = if executor.kind.as_str() == ursi_agent_runtime::RUNTIME_ACP {
                    let Some(runner) = &self.runtime_acp else {
                        let err = ursi_agent_runtime::ExecutorError::DoNotRetry(
                            "未配置 runtime-acp 执行器".into(),
                        );
                        return (Err(NodeInvocationError::Runner(err)), None);
                    };
                    runner
                } else {
                    &self.runner
                };
                let result = runner
                    .run(&input, &role, &executor, self.env.clone(), sink)
                    .await;
                match result {
                    Ok(result) => (Ok(result.output), Some(result.artifacts)),
                    Err(err) => (Err(NodeInvocationError::Runner(err)), None),
                }
            }
            ursi_domain::NodeType::Script => {
                let script = spec.script.as_deref().unwrap_or_default();
                let language = spec.script_language.as_deref().unwrap_or("shell");
                match self.script_executor.exec(script, language).await {
                    Ok(output) => (Ok(output), None),
                    Err(err) => (Err(NodeInvocationError::Script(err)), None),
                }
            }
            ursi_domain::NodeType::Approval => {
                (Err(NodeInvocationError::ApprovalRequested), None)
            }
        }
    }

    /// 解析冻结角色配置为 domain Role。
    ///
    /// 快照 roles 是创建时冻结的 Role JSON（camelCase）；节点未引用角色或
    /// 冻结集合缺少引用的角色都是快照不完整，明确报错。快照每次从存储
    /// 读取：engine 无状态，重启恢复与取消路径都安全。
    async fn frozen_role(
        &self,
        run_id: &str,
        role_id: Option<&str>,
    ) -> Result<FrozenRole, EngineError> {
        let Some(role_id) = role_id else {
            return Err(EngineError::FrozenRoleMissing {
                run_id: run_id.to_string(),
                role_id: "（节点未引用）".to_string(),
            });
        };
        let snapshot = self
            .store
            .get_snapshot(run_id)
            .await?
            .ok_or_else(|| EngineError::RunNotFound(run_id.to_string()))?;
        let json = snapshot.roles.get(role_id).ok_or_else(|| {
            EngineError::FrozenRoleMissing {
                run_id: run_id.to_string(),
                role_id: role_id.to_string(),
            }
        })?;
        serde_json::from_value(json.clone()).map_err(|e| EngineError::FrozenRoleInvalid {
            role_id: role_id.to_string(),
            reason: e.to_string(),
        })
    }

    /// 状态 + 事件原子提交，成功后广播。顺序不可颠倒。
    async fn commit_and_emit(
        &self,
        run: &Run,
        generation: u64,
        events: Vec<TelemetryEvent>,
    ) -> Result<(), EngineError> {
        self.store.commit_run(run, generation, &events).await?;
        for event in events {
            self.events.emit(&run.id, event);
        }
        Ok(())
    }
}

/// 单节点执行结局。
enum NodeOutcome {
    /// 成功或失败已落状态，继续调度。
    Completed,
    /// 进入等待审批，调度循环退出。
    WaitingApproval,
}

impl NodeOutcome {
    fn is_waiting_approval(&self) -> bool {
        matches!(self, NodeOutcome::WaitingApproval)
    }
}

/// 节点执行体错误。
#[derive(Debug, thiserror::Error)]
enum NodeInvocationError {
    #[error("{0}")]
    Runner(#[from] ursi_agent_runtime::ExecutorError),
    #[error("{0}")]
    Script(#[from] ScriptExecutionError),
    #[error("等待人工审批")]
    ApprovalRequested,
    /// 冻结角色解析失败（快照不完整或角色 JSON 非法）。
    #[error("{0}")]
    Frozen(EngineError),
}

/// 引擎错误。
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("存储错误：{0}")]
    Store(#[from] crate::storage::StoreError),
    #[error("执行器错误：{0}")]
    Executor(#[from] ursi_agent_runtime::ExecutorError),
    #[error("租约错误：{0}")]
    Lease(#[from] LeaseError),
    #[error("运行 {0} 不存在")]
    RunNotFound(String),
    #[error("运行 {0} 节点 {1} 不存在")]
    NodeNotFound(String, String),
    #[error("状态冲突：{0}")]
    StateConflict(String),
    #[error("无法确认执行已结束：{0}")]
    OutcomeUnknown(String),
    #[error("运行调度任务异常退出：{0}")]
    DriverTask(#[source] tokio::task::JoinError),
    #[error("工作流定义不合法：{0}")]
    InvalidDefinition(#[from] ursi_domain::WorkflowError),
    #[error("脚本执行错误：{0}")]
    Script(#[from] ScriptExecutionError),
    /// 迟到结果：执行发起时的 attempt 已不是当前 attempt（执行期间发生
    /// 返工），结果被忽略且不影响当前轮次（SPEC「审批、重试与返工」）。
    #[error(
        "运行 {run_id} 节点 {node_id} 的结果是旧 attempt {stale_attempt} 的迟到结果，当前 attempt 已是 {current_attempt}，已丢弃"
    )]
    LateAttemptDiscarded {
        run_id: String,
        node_id: String,
        stale_attempt: u32,
        current_attempt: u32,
    },
    /// 冻结快照缺少节点引用的角色配置。
    #[error("运行 {run_id} 冻结快照缺少角色 {role_id} 的配置")]
    FrozenRoleMissing { run_id: String, role_id: String },
    /// 冻结的角色 JSON 非法（反序列化为 domain Role 失败）。
    #[error("角色 {role_id} 的冻结配置非法：{reason}")]
    FrozenRoleInvalid { role_id: String, reason: String },
    /// 未装配资源释放器。
    #[error("资源释放器未配置，不能执行资源收尾")]
    ReleaserNotConfigured,
}

/// 占位执行环境（第二阶段随角色冻结配置替换为沙箱环境）。
struct PlaceholderEnv;

#[async_trait]
impl ExecutionEnv for PlaceholderEnv {
    async fn exec(&self, cmd: &str) -> Result<(i32, String), ursi_domain::EnvError> {
        Err(ursi_domain::EnvError::Other(format!(
            "占位环境不可执行命令：{cmd}"
        )))
    }

    async fn write_file(&self, path: &str, _content: &[u8]) -> Result<(), ursi_domain::EnvError> {
        Err(ursi_domain::EnvError::Other(format!(
            "占位环境不可写文件：{path}"
        )))
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, ursi_domain::EnvError> {
        Err(ursi_domain::EnvError::Other(format!(
            "占位环境不可读文件：{path}"
        )))
    }
}

// ---------- 图辅助 ----------

/// node_id 的全部传递祖先。
fn ancestors_of(wf: &WorkflowDefinition, node_id: &str) -> HashSet<String> {
    let mut rev: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &wf.edges {
        rev.entry(edge.target.as_str()).or_default().push(edge.source.as_str());
    }
    let mut seen = HashSet::new();
    let mut stack = vec![node_id];
    while let Some(current) = stack.pop() {
        if let Some(parents) = rev.get(current) {
            for parent in parents {
                if seen.insert((*parent).to_string()) {
                    stack.push(parent);
                }
            }
        }
    }
    seen
}

/// node_id 的全部传递下游。
fn descendants_of(wf: &WorkflowDefinition, node_id: &str) -> HashSet<String> {
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &wf.edges {
        adj.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
    }
    let mut seen = HashSet::new();
    let mut stack = vec![node_id];
    while let Some(current) = stack.pop() {
        if let Some(nexts) = adj.get(current) {
            for next in nexts {
                if seen.insert((*next).to_string()) {
                    stack.push(next);
                }
            }
        }
    }
    seen
}

/// 下一个就绪节点：pending 且全部直接上游已 succeeded
/// （多依赖节点等全部上游成功后才就绪）。按定义顺序返回首个。
fn ready_node(wf: &WorkflowDefinition, run: &Run) -> Option<String> {
    let status_of: HashMap<&str, NodeStatus> = run
        .nodes
        .iter()
        .map(|n| (n.node_id.as_str(), n.status))
        .collect();
    wf.nodes
        .iter()
        .filter(|node| {
            status_of.get(node.id.as_str()).copied() == Some(NodeStatus::Pending)
        })
        .find(|node| {
            wf.edges
                .iter()
                .filter(|edge| edge.target == node.id)
                .all(|edge| status_of.get(edge.source.as_str()).copied() == Some(NodeStatus::Succeeded))
        })
        .map(|node| node.id.clone())
}

/// 当前有效轮次的上游产物上下文：直接上游的最新输出（返工后新 attempt
/// 覆盖旧输出；旧产物不自动成为新轮输出，仅当前轮次值参与交接）。
fn current_round_artifact_context(run: &Run, node_id: &str) -> String {
    let mut parts = Vec::new();
    for edge in &run.workflow.edges {
        if edge.target != node_id {
            continue;
        }
        if let Some(up) = run.nodes.iter().find(|n| n.node_id == edge.source) {
            if let Some(output) = &up.output {
                parts.push(format!("[{}] {}", up.node_id, output));
            }
        }
    }
    parts.join("\n")
}

/// 查找节点状态（借用版）。
fn node_of<'a>(run: &'a Run, node_id: &str) -> Result<&'a NodeRun, EngineError> {
    run.nodes
        .iter()
        .find(|n| n.node_id == node_id)
        .ok_or_else(|| EngineError::NodeNotFound(run.id.clone(), node_id.to_string()))
}

/// 查找节点状态（可变借用版）。
fn node_mut<'a>(run: &'a mut Run, node_id: &str) -> Result<&'a mut NodeRun, EngineError> {
    let run_id = run.id.clone();
    run.nodes
        .iter_mut()
        .find(|n| n.node_id == node_id)
        .ok_or_else(|| EngineError::NodeNotFound(run_id, node_id.to_string()))
}

/// 运行级生命周期事件。
fn lifecycle_event(run: &Run, name: &str, message: &str) -> TelemetryEvent {
    TelemetryEvent {
        category: EventCategory::Lifecycle,
        name: name.to_string(),
        phase: EventPhase::Finish,
        message: message.to_string(),
        attributes: {
            let mut attrs = HashMap::new();
            attrs.insert(
                "runId".to_string(),
                serde_json::Value::String(run.id.clone()),
            );
            attrs
        },
    }
}

/// 节点级事件，属性携带运行与节点标识。
fn node_event(run: &Run, node_id: &str, name: &str, message: impl Into<String>, phase: EventPhase) -> TelemetryEvent {
    TelemetryEvent {
        category: EventCategory::Node,
        name: name.to_string(),
        phase,
        message: message.into(),
        attributes: {
            let mut attrs = HashMap::new();
            attrs.insert(
                "runId".to_string(),
                serde_json::Value::String(run.id.clone()),
            );
            attrs.insert(
                "nodeId".to_string(),
                serde_json::Value::String(node_id.to_string()),
            );
            attrs
        },
    }
}
