//! 流程执行引擎。
//!
//! 把一次运行从工作流定义实例化，按拓扑顺序调度节点执行，管理状态机流转、
//! 人工审批与打回、失败重试与终态。所有状态变更经 [`RunRepository::commit_run`]
//! （持有代数 CAS）原子提交成功后再经 [`EventBus`] 广播；先 commit 后 emit，
//! 顺序不可颠倒（DESIGN「一致性归属」：广播是实时通知，数据库事件是历史
//! 重放的事实来源）。
//!
//! 调度模型：运行由调度循环同步驱动到终态或审批挂起。start_run / approve /
//! reject 先取得租约（空闲或到期时接管，代数递增），此后每轮提交都以该代数
//! 做 CAS；租约被他人接管后，旧持有者的提交因代数过期被拒，不覆盖当前结果。
//! 失败终态后不再调度新节点。
//!
//! 第二阶段接口点：
//! - 角色冻结配置接入：agent 执行时按 role_id 查冻结的角色配置（提示词、
//!   模型、skills、MCP、执行器）渲染 Runner 输入，当前以节点名 + 角色占位；
//! - 沙箱脚本执行：[`ScriptExecutor`] 注入实现，真实沙箱执行后续阶段接
//!   channel。

mod events;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use ursi_agent_runtime::{EventSink, InvocationInput, InvocationResult, Runner};
use ursi_domain::{
    EventCategory, EventPhase, ExecutionEnv, NodeRun, NodeStatus, Run, RunStatus, TelemetryEvent,
    WorkflowDefinition, WorkflowNode, validate_workflow,
};

use crate::runs::{FrozenRoles, RunRepository};
pub use crate::runs::{LeaseError, LeaseState, LeaseTable};

pub use events::EventBus;

/// 脚本执行器接口：本阶段注入替身，真实沙箱执行后续阶段接 channel。
#[async_trait]
pub trait ScriptExecutor: Send + Sync {
    /// 执行脚本，返回输出。language 如 "shell" / "python"。
    async fn exec(&self, script: &str, language: &str) -> Result<String, ScriptExecutionError>;
}

/// 脚本执行错误。
#[derive(Debug, thiserror::Error)]
pub enum ScriptExecutionError {
    #[error("脚本执行失败：{0}")]
    Failed(String),
    #[error("不支持的语言：{0}")]
    UnsupportedLanguage(String),
}

/// 流程执行引擎：编排调度、状态机、人工审批、重试与事件广播。
pub struct Engine {
    store: Arc<dyn RunRepository>,
    runner: Arc<dyn Runner>,
    events: Arc<EventBus>,
    leases: Arc<dyn LeaseTable>,
    script_executor: Arc<dyn ScriptExecutor>,
    /// Runner 调用时的环境（占位，第二阶段随角色冻结配置装配沙箱环境）。
    env: Arc<dyn ExecutionEnv>,
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
            store,
            runner,
            events,
            leases,
            script_executor,
            env: Arc::new(PlaceholderEnv),
            lease_ttl_ms: 300_000,
            holder: format!("engine-{}", uuid::Uuid::new_v4().simple()),
        }
    }

    /// 注入执行环境（第二阶段随角色冻结配置装配）。
    pub fn with_env(mut self, env: Arc<dyn ExecutionEnv>) -> Self {
        self.env = env;
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

    /// 从工作流定义创建一次运行，冻结工作流快照。
    ///
    /// 校验定义 → 生成 run id → 快照冻结 workflow → 初始化节点全 pending →
    /// generation=1 → status=queued → 入库。校验失败不产生运行。
    /// 角色配置冻结参数 `frozen_config` 本阶段传空映射占位，下一阶段接入
    /// 角色能力、执行器与沙箱配置的冻结（SPEC「运行创建与配置冻结」）。
    pub async fn create_run(
        &self,
        wf: &WorkflowDefinition,
        frozen_config: &FrozenRoles,
    ) -> Result<Run, EngineError> {
        validate_workflow(wf).map_err(EngineError::InvalidDefinition)?;
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
    pub async fn start_run(&self, run_id: &str) -> Result<(), EngineError> {
        let generation = self.acquire(run_id).await?;
        let mut run = self.load(run_id).await?;
        run.generation = generation;
        self.drive(&mut run, generation).await
    }

    /// 审批放行：让等待审批的节点继续，推进下游。
    pub async fn approve(&self, run_id: &str, node_id: &str) -> Result<(), EngineError> {
        let generation = self.acquire(run_id).await?;
        let mut run = self.load(run_id).await?;
        run.generation = generation;
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
        self.drive(&mut run, generation).await
    }

    /// 审批打回：把运行重置到目标环节重新执行。
    ///
    /// target 必须是审批节点的传递祖先且审批节点当前 waiting，否则返回
    /// 状态冲突且状态不变；合法打回时 target 及其全部下游重置 pending、
    /// target reworks+1，从 target 重新调度。旧输出不自动成为新轮次输出；
    /// attempts / reworks 累计保留（执行编号单调递增不复用）。
    pub async fn reject(
        &self,
        run_id: &str,
        node_id: &str,
        target_node_id: &str,
    ) -> Result<(), EngineError> {
        let generation = self.acquire(run_id).await?;
        let mut run = self.load(run_id).await?;
        run.generation = generation;

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
        self.drive(&mut run, generation).await
    }
}

impl Engine {
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
        async fn drive(&self, run: &mut Run, generation: u64) -> Result<(), EngineError> {
        let wf = run.workflow.clone();
        if matches!(
            run.status,
            RunStatus::Succeeded | RunStatus::Failed | RunStatus::Cancelled
        ) {
            return Ok(());
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
        loop {
            if matches!(
                run.status,
                RunStatus::Succeeded | RunStatus::Failed | RunStatus::Cancelled
            ) {
                return Ok(());
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
                .execute_node(run, &wf, &node_id, generation)
                .await?
                .is_waiting_approval()
            {
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
        let runner_events = Mutex::new(Vec::new());
        let invocation = self.invoke(&spec, run, node_id, &runner_events).await;
        let runner_events = runner_events.into_inner().expect("事件收集互斥锁可用");

        match invocation {
            Ok(output) => {
                {
                    let node = node_mut(run, node_id)?;
                    node.status = NodeStatus::Succeeded;
                    node.output = Some(output.clone());
                    node.error = None;
                }
                // 输出随事件属性留档，历史轮次输出可从 events 区分。
                let mut success = node_event(run, node_id, "node.succeeded", "执行成功", EventPhase::Finish);
                success.attributes.insert(
                    "output".to_string(),
                    serde_json::Value::String(output),
                );
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
                let retryable = node_of(run, node_id)?.attempts < spec.max_attempts;
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
                    // 超过重试上限：节点 failed 且运行进入失败终态，
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
    ) -> Result<String, NodeInvocationError> {
        match spec.node_type {
            ursi_domain::NodeType::Agent => {
                // 本阶段：prompt 用节点名 + 角色占位；artifact_context 填上游
                // 产物输出拼接。角色冻结配置（提示词、模型、skills、MCP、
                // 执行器）在下一阶段接入。
                let prompt = format!(
                    "{}（角色：{}）",
                    spec.name,
                    spec.role_id.as_deref().unwrap_or("未指定")
                );
                let input = InvocationInput {
                    prompt,
                    artifact_context: upstream_outputs(run, node_id),
                    run_id: run.id.clone(),
                    node_id: node_id.to_string(),
                };
                let role = ursi_domain::Role {
                    id: spec.role_id.clone().unwrap_or_default(),
                    name: spec.name.clone(),
                    prompt: String::new(),
                    model: None,
                    skills: Vec::new(),
                    mcp_servers: Vec::new(),
                    executor_id: None,
                };
                let executor = ursi_domain::Executor {
                    id: spec.role_id.clone().unwrap_or_default(),
                    name: "占位执行器".to_string(),
                    kind: ursi_domain::ExecutorKind::Mock,
                };
                let sink: EventSink<'_> = &|event: TelemetryEvent| {
                    runner_events.lock().expect("事件收集互斥锁可用").push(event);
                };
                let result: InvocationResult = self
                    .runner
                    .run(&input, &role, &executor, self.env.clone(), sink)
                    .await
                    .map_err(NodeInvocationError::Runner)?;
                Ok(result.output)
            }
            ursi_domain::NodeType::Script => {
                let script = spec.script.as_deref().unwrap_or_default();
                let language = spec.script_language.as_deref().unwrap_or("shell");
                Ok(self.script_executor.exec(script, language).await?)
            }
            ursi_domain::NodeType::Approval => Err(NodeInvocationError::ApprovalRequested),
        }
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
    #[error("工作流定义不合法：{0}")]
    InvalidDefinition(#[from] ursi_domain::WorkflowError),
    #[error("脚本执行错误：{0}")]
    Script(#[from] ScriptExecutionError),
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

/// 拼接上游产物输出：直接上游的当前有效输出。
fn upstream_outputs(run: &Run, node_id: &str) -> String {
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
