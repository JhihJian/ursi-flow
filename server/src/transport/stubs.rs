//! transport 测试替身：记录调用、可控返回与故障注入的业务接口实现。
//!
//! 各业务域并行开发中，这里以内存替身充当域服务；替身行为对应 SPEC
//! 验收语义：NotFound / Conflict / Internal 错误注入、调用参数记录、
//! 可控事件推送与订阅释放追踪。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use ursi_domain::{EventCategory, EventPhase, TelemetryEvent, WorkflowDefinition};

use crate::transport::error::ApiError;
use crate::transport::ports::{
    ArtifactDto, ArtifactsApi, ConnectionDto, ConnectionsApi, CreateRunRequest, EventFeed,
    EventStream, NumberedEvent, PrepareSandboxRequest, RoleDto, RolesApi, RunDto, RunsApi,
    SandboxDto, SandboxesApi, WorkflowApi,
};

/// 调用记录：方法名与参数快照，供断言"业务替身收到完整且正确的参数"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub method: String,
    pub args: Vec<String>,
}

/// 调用记录器。
#[derive(Default)]
pub struct Recorder {
    calls: Mutex<Vec<Call>>,
}

impl Recorder {
    pub fn record(&self, method: &str, args: &[String]) {
        self.calls
            .lock()
            .unwrap()
            .push(Call {
                method: method.into(),
                args: args.to_vec(),
            });
    }

    pub fn snapshot(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    pub fn method_names(&self) -> Vec<String> {
        self.snapshot().into_iter().map(|c| c.method).collect()
    }
}

/// 故障注入：命中方法名时返回对应 ApiError 一次（或持续）。
#[derive(Default, Clone)]
pub struct Faults {
    inner: std::sync::Arc<Mutex<HashMap<String, ApiError>>>,
}

impl Faults {
    pub fn set(&self, method: &str, err: ApiError) {
        self.inner
            .lock()
            .unwrap()
            .insert(method.to_string(), err);
    }

    pub fn take(&self, method: &str) -> Option<ApiError> {
        self.inner.lock().unwrap().remove(method)
    }
}

// ---------------------------------------------------------------------------
// workflows 替身
// ---------------------------------------------------------------------------

/// 内存工作流替身：按 id 存储 domain 定义，支持故障注入。
pub struct FakeWorkflows {
    pub recorder: Recorder,
    pub faults: Faults,
    rows: Mutex<HashMap<String, WorkflowDefinition>>,
}

impl Default for FakeWorkflows {
    fn default() -> Self {
        FakeWorkflows {
            recorder: Recorder::default(),
            faults: Faults::default(),
            rows: Mutex::new(HashMap::new()),
        }
    }
}

impl FakeWorkflows {
    fn exists(&self, id: &str) -> bool {
        self.rows.lock().unwrap().contains_key(id)
    }
}

#[async_trait]
impl WorkflowApi for FakeWorkflows {
    async fn create_workflow(
        &self,
        definition: WorkflowDefinition,
    ) -> Result<WorkflowDefinition, ApiError> {
        self.recorder.record("create_workflow", &[definition.id.clone()]);
        if let Some(err) = self.faults.take("create_workflow") {
            return Err(err);
        }
        if self.exists(&definition.id) {
            return Err(ApiError::conflict(format!("流程 {} 已存在", definition.id)));
        }
        self.rows
            .lock()
            .unwrap()
            .insert(definition.id.clone(), definition.clone());
        Ok(definition)
    }

    async fn list_workflows(&self) -> Result<Vec<WorkflowDefinition>, ApiError> {
        self.recorder.record("list_workflows", &[]);
        let mut rows: Vec<_> = self.rows.lock().unwrap().values().cloned().collect();
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(rows)
    }

    async fn get_workflow(&self, id: &str) -> Result<WorkflowDefinition, ApiError> {
        self.recorder.record("get_workflow", &[id.to_string()]);
        if let Some(err) = self.faults.take("get_workflow") {
            return Err(err);
        }
        self.rows
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| ApiError::not_found(format!("流程 {id}")))
    }

    async fn update_workflow(
        &self,
        id: &str,
        definition: WorkflowDefinition,
    ) -> Result<WorkflowDefinition, ApiError> {
        self.recorder
            .record("update_workflow", &[id.to_string(), definition.id.clone()]);
        if let Some(err) = self.faults.take("update_workflow") {
            return Err(err);
        }
        let mut rows = self.rows.lock().unwrap();
        if !rows.contains_key(id) {
            return Err(ApiError::not_found(format!("流程 {id}")));
        }
        rows.insert(id.to_string(), definition.clone());
        Ok(definition)
    }

    async fn delete_workflow(&self, id: &str) -> Result<(), ApiError> {
        self.recorder.record("delete_workflow", &[id.to_string()]);
        if let Some(err) = self.faults.take("delete_workflow") {
            return Err(err);
        }
        self.rows
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| ApiError::not_found(format!("流程 {id}")))?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// roles 替身
// ---------------------------------------------------------------------------

/// 内存角色替身。响应不含凭据字段由 DTO 结构保证。
pub struct FakeRoles {
    pub recorder: Recorder,
    pub faults: Faults,
    rows: Mutex<HashMap<String, RoleDto>>,
}

impl Default for FakeRoles {
    fn default() -> Self {
        FakeRoles {
            recorder: Recorder::default(),
            faults: Faults::default(),
            rows: Mutex::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl RolesApi for FakeRoles {
    async fn create_role(&self, role: RoleDto) -> Result<RoleDto, ApiError> {
        self.recorder.record("create_role", &[role.id.clone()]);
        if let Some(err) = self.faults.take("create_role") {
            return Err(err);
        }
        if self
            .rows
            .lock()
            .unwrap()
            .contains_key(&role.id)
        {
            return Err(ApiError::conflict(format!("角色 {} 已存在", role.id)));
        }
        self.rows.lock().unwrap().insert(role.id.clone(), role.clone());
        Ok(role)
    }

    async fn list_roles(&self) -> Result<Vec<RoleDto>, ApiError> {
        self.recorder.record("list_roles", &[]);
        let mut rows: Vec<_> = self.rows.lock().unwrap().values().cloned().collect();
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(rows)
    }

    async fn get_role(&self, id: &str) -> Result<RoleDto, ApiError> {
        self.recorder.record("get_role", &[id.to_string()]);
        self.rows
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| ApiError::not_found(format!("角色 {id}")))
    }

    async fn update_role(&self, id: &str, role: RoleDto) -> Result<RoleDto, ApiError> {
        self.recorder.record("update_role", &[id.to_string()]);
        if let Some(err) = self.faults.take("update_role") {
            return Err(err);
        }
        let mut rows = self.rows.lock().unwrap();
        if !rows.contains_key(id) {
            return Err(ApiError::not_found(format!("角色 {id}")));
        }
        rows.insert(id.to_string(), role.clone());
        Ok(role)
    }

    async fn delete_role(&self, id: &str) -> Result<(), ApiError> {
        self.recorder.record("delete_role", &[id.to_string()]);
        // 引用冲突场景：roles SPEC「引用登记与删除约束」。
        if id == "role-referenced" {
            return Err(ApiError::conflict(format!("角色 {id} 仍被流程引用")));
        }
        self.rows
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| ApiError::not_found(format!("角色 {id}")))?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// runs 替身
// ---------------------------------------------------------------------------

/// 内存运行替身：状态转换记录与状态冲突注入。
pub struct FakeRuns {
    pub recorder: Recorder,
    pub faults: Faults,
    rows: Mutex<HashMap<String, RunDto>>,
    next_id: AtomicU64,
}

impl Default for FakeRuns {
    fn default() -> Self {
        FakeRuns {
            recorder: Recorder::default(),
            faults: Faults::default(),
            rows: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

impl FakeRuns {
    /// 预置一个运行。
    pub fn seed(&self, mut run: RunDto) {
        if run.id.is_empty() {
            run.id = format!("run-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        }
        self.rows.lock().unwrap().insert(run.id.clone(), run);
    }
}

#[async_trait]
impl RunsApi for FakeRuns {
    async fn create_run(&self, request: CreateRunRequest) -> Result<RunDto, ApiError> {
        self.recorder
            .record("create_run", &[request.workflow_id.clone(), request.input.clone()]);
        if let Some(err) = self.faults.take("create_run") {
            return Err(err);
        }
        let id = format!("run-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let run = RunDto {
            id: id.clone(),
            status: "queued".into(),
            workflow: WorkflowDefinition {
                id: request.workflow_id,
                name: "demo".into(),
                nodes: Vec::new(),
                edges: Vec::new(),
            },
            nodes: Vec::new(),
            generation: 1,
        };
        self.rows.lock().unwrap().insert(id, run.clone());
        Ok(run)
    }

    async fn start_run(&self, run_id: &str) -> Result<RunDto, ApiError> {
        self.recorder.record("start_run", &[run_id.to_string()]);
        self.transition(run_id, "start_run", "running")
    }

    async fn approve(&self, run_id: &str, node_id: &str) -> Result<RunDto, ApiError> {
        self.recorder
            .record("approve", &[run_id.to_string(), node_id.to_string()]);
        let run = self.must_get(run_id)?;
        // 状态冲突：只有 waiting 运行可以放行（runs SPEC 审批语义）。
        if run.status != "waiting" {
            return Err(ApiError::conflict(format!(
                "运行 {run_id} 不在等待审批状态"
            )));
        }
        self.transition(run_id, "approve", "running")
    }

    async fn reject(
        &self,
        run_id: &str,
        node_id: &str,
        target_node_id: &str,
    ) -> Result<RunDto, ApiError> {
        self.recorder.record(
            "reject",
            &[run_id.to_string(), node_id.to_string(), target_node_id.to_string()],
        );
        let run = self.must_get(run_id)?;
        if run.status != "waiting" {
            return Err(ApiError::conflict(format!(
                "运行 {run_id} 不在等待审批状态"
            )));
        }
        self.transition(run_id, "reject", "running")
    }

    async fn cancel_run(&self, run_id: &str) -> Result<RunDto, ApiError> {
        self.recorder.record("cancel_run", &[run_id.to_string()]);
        // 取消幂等：重复取消终态运行不报冲突。
        let run = self.must_get(run_id)?;
        if run.status == "cancelled" {
            return Ok(run);
        }
        self.transition(run_id, "cancel_run", "cancelled")
    }

    async fn get_run(&self, run_id: &str) -> Result<RunDto, ApiError> {
        self.recorder.record("get_run", &[run_id.to_string()]);
        self.must_get(run_id)
    }

    async fn list_runs(&self) -> Result<Vec<RunDto>, ApiError> {
        self.recorder.record("list_runs", &[]);
        let mut rows: Vec<_> = self.rows.lock().unwrap().values().cloned().collect();
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(rows)
    }
}

impl FakeRuns {
    fn must_get(&self, run_id: &str) -> Result<RunDto, ApiError> {
        self.rows
            .lock()
            .unwrap()
            .get(run_id)
            .cloned()
            .ok_or_else(|| ApiError::not_found(format!("运行 {run_id}")))
    }

    fn transition(&self, run_id: &str, method: &str, status: &str) -> Result<RunDto, ApiError> {
        if let Some(err) = self.faults.take(method) {
            return Err(err);
        }
        let mut rows = self.rows.lock().unwrap();
        let run = rows
            .get_mut(run_id)
            .ok_or_else(|| ApiError::not_found(format!("运行 {run_id}")))?;
        run.status = status.to_string();
        Ok(run.clone())
    }
}

// ---------------------------------------------------------------------------
// artifacts / sandboxes / connections 替身
// ---------------------------------------------------------------------------

/// 内存产物替身。
pub struct FakeArtifacts {
    pub recorder: Recorder,
    pub faults: Faults,
    pub rows: Mutex<Vec<ArtifactDto>>,
}

impl Default for FakeArtifacts {
    fn default() -> Self {
        FakeArtifacts {
            recorder: Recorder::default(),
            faults: Faults::default(),
            rows: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl ArtifactsApi for FakeArtifacts {
    async fn get_artifact(&self, artifact_id: &str) -> Result<ArtifactDto, ApiError> {
        self.recorder
            .record("get_artifact", &[artifact_id.to_string()]);
        if let Some(err) = self.faults.take("get_artifact") {
            return Err(err);
        }
        self.rows
            .lock()
            .unwrap()
            .iter()
            .find(|a| a.id == artifact_id)
            .cloned()
            .ok_or_else(|| ApiError::not_found(format!("产物 {artifact_id}")))
    }

    async fn list_artifacts(&self, run_id: Option<&str>) -> Result<Vec<ArtifactDto>, ApiError> {
        self.recorder
            .record("list_artifacts", &[run_id.unwrap_or("").to_string()]);
        let rows = self.rows.lock().unwrap();
        Ok(rows
            .iter()
            .filter(|a| run_id.is_none_or(|r| a.run_id == r))
            .cloned()
            .collect())
    }
}

/// 内存沙箱替身：准备/状态/释放。
pub struct FakeSandboxes {
    pub recorder: Recorder,
    pub faults: Faults,
    rows: Mutex<HashMap<String, SandboxDto>>,
    next_id: AtomicU64,
}

impl Default for FakeSandboxes {
    fn default() -> Self {
        FakeSandboxes {
            recorder: Recorder::default(),
            faults: Faults::default(),
            rows: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

#[async_trait]
impl SandboxesApi for FakeSandboxes {
    async fn prepare(&self, request: PrepareSandboxRequest) -> Result<SandboxDto, ApiError> {
        self.recorder.record("prepare", &[request.run_id.clone()]);
        if let Some(err) = self.faults.take("prepare") {
            return Err(err);
        }
        let id = format!("sbx-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let sbx = SandboxDto {
            id,
            run_id: request.run_id,
            status: "running".into(),
            endpoint: Some("10.0.0.1:22".into()),
        };
        self.rows
            .lock()
            .unwrap()
            .insert(sbx.id.clone(), sbx.clone());
        Ok(sbx)
    }

    async fn get_sandbox(&self, sandbox_id: &str) -> Result<SandboxDto, ApiError> {
        self.recorder
            .record("get_sandbox", &[sandbox_id.to_string()]);
        self.rows
            .lock()
            .unwrap()
            .get(sandbox_id)
            .cloned()
            .ok_or_else(|| ApiError::not_found(format!("沙箱 {sandbox_id}")))
    }

    async fn list_sandboxes(&self, run_id: Option<&str>) -> Result<Vec<SandboxDto>, ApiError> {
        self.recorder
            .record("list_sandboxes", &[run_id.unwrap_or("").to_string()]);
        let mut rows: Vec<_> = self
            .rows
            .lock()
            .unwrap()
            .values()
            .filter(|s| run_id.is_none_or(|r| s.run_id == r))
            .cloned()
            .collect();
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(rows)
    }

    async fn release(&self, sandbox_id: &str) -> Result<SandboxDto, ApiError> {
        self.recorder.record("release", &[sandbox_id.to_string()]);
        if let Some(err) = self.faults.take("release") {
            return Err(err);
        }
        let mut rows = self.rows.lock().unwrap();
        let sbx = rows
            .get_mut(sandbox_id)
            .ok_or_else(|| ApiError::not_found(format!("沙箱 {sandbox_id}")))?;
        sbx.status = "released".into();
        Ok(sbx.clone())
    }
}

/// 内存连接替身。删除引用冲突语义对齐 connections SPEC。
pub struct FakeConnections {
    pub recorder: Recorder,
    pub faults: Faults,
    rows: Mutex<HashMap<String, ConnectionDto>>,
}

impl Default for FakeConnections {
    fn default() -> Self {
        FakeConnections {
            recorder: Recorder::default(),
            faults: Faults::default(),
            rows: Mutex::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl ConnectionsApi for FakeConnections {
    async fn create_connection(&self, connection: ConnectionDto) -> Result<ConnectionDto, ApiError> {
        self.recorder
            .record("create_connection", &[connection.id.clone()]);
        if let Some(err) = self.faults.take("create_connection") {
            return Err(err);
        }
        if self.rows.lock().unwrap().contains_key(&connection.id) {
            return Err(ApiError::conflict(format!(
                "连接 {} 已存在",
                connection.id
            )));
        }
        self.rows
            .lock()
            .unwrap()
            .insert(connection.id.clone(), connection.clone());
        Ok(connection)
    }

    async fn list_connections(&self) -> Result<Vec<ConnectionDto>, ApiError> {
        self.recorder.record("list_connections", &[]);
        if let Some(err) = self.faults.take("list_connections") {
            return Err(err);
        }
        let mut rows: Vec<_> = self.rows.lock().unwrap().values().cloned().collect();
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(rows)
    }

    async fn get_connection(&self, id: &str) -> Result<ConnectionDto, ApiError> {
        self.recorder.record("get_connection", &[id.to_string()]);
        self.rows
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| ApiError::not_found(format!("连接 {id}")))
    }

    async fn update_connection(
        &self,
        id: &str,
        connection: ConnectionDto,
    ) -> Result<ConnectionDto, ApiError> {
        self.recorder.record("update_connection", &[id.to_string()]);
        let mut rows = self.rows.lock().unwrap();
        if !rows.contains_key(id) {
            return Err(ApiError::not_found(format!("连接 {id}")));
        }
        rows.insert(id.to_string(), connection.clone());
        Ok(connection)
    }

    async fn delete_connection(&self, id: &str) -> Result<(), ApiError> {
        self.recorder.record("delete_connection", &[id.to_string()]);
        // 引用冲突：connections SPEC「已登记引用的连接删除返回冲突」。
        if id == "conn-referenced" {
            return Err(ApiError::conflict(format!("连接 {id} 仍被角色引用")));
        }
        self.rows
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| ApiError::not_found(format!("连接 {id}")))?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// EventFeed 替身
// ---------------------------------------------------------------------------

/// 可控事件源替身：内存持久事件 + mpsc 实时通知，追踪订阅释放。
pub struct FakeEventFeed {
    /// run_id -> 有序事件（按 seq 升序）。
    history: Mutex<HashMap<String, Vec<NumberedEvent>>>,
    /// 已登记的运行（run 存在但可能还没有事件）。
    known_runs: Mutex<std::collections::HashSet<String>>,
    /// run_id -> 活跃订阅 sender 列表。
    subscribers: Mutex<HashMap<String, Vec<tokio::sync::mpsc::Sender<NumberedEvent>>>>,
    /// 累计建立的订阅数。
    subscribe_count: AtomicU64,
    /// 已关闭（客户端断开后 sender 全部 drop / send 失败）的订阅数。
    closed_count: AtomicU64,
    /// 历史读取故障注入。
    pub faults: Faults,
    next_seq: AtomicU64,
}

impl Default for FakeEventFeed {
    fn default() -> Self {
        FakeEventFeed {
            history: Mutex::new(HashMap::new()),
            known_runs: Mutex::new(std::collections::HashSet::new()),
            subscribers: Mutex::new(HashMap::new()),
            subscribe_count: AtomicU64::new(0),
            closed_count: AtomicU64::new(0),
            faults: Faults::default(),
            next_seq: AtomicU64::new(0),
        }
    }
}

impl FakeEventFeed {
    /// 登记一个已存在的运行（可无事件）。
    pub fn register_run(&self, run_id: &str) {
        self.known_runs
            .lock()
            .unwrap()
            .insert(run_id.to_string());
    }

    /// 追加一条持久事件（模拟 runs 提交成功后的持久记录），同时推送给
    /// 活跃订阅者（模拟提交后广播）。
    pub fn publish(&self, run_id: &str, name: &str) -> NumberedEvent {
        self.register_run(run_id);
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let event = NumberedEvent {
            run_id: run_id.to_string(),
            seq,
            event: TelemetryEvent {
                category: EventCategory::Node,
                name: name.to_string(),
                phase: EventPhase::Progress,
                message: format!("{name} 消息"),
                attributes: Default::default(),
            },
        };
        self.history
            .lock()
            .unwrap()
            .entry(run_id.to_string())
            .or_default()
            .push(event.clone());
        // 广播：send 失败即订阅已关闭。
        let mut subs = self.subscribers.lock().unwrap();
        let senders = subs.entry(run_id.to_string()).or_default();
        senders.retain(|sender| {
            let ok = sender.try_send(event.clone()).is_ok();
            if !ok {
                self.closed_count.fetch_add(1, Ordering::SeqCst);
            }
            ok
        });
        event
    }

    /// 模拟"提交成功但通知丢失"（慢消费者场景）：只写持久源，不广播。
    pub fn publish_silently(&self, run_id: &str, name: &str) -> NumberedEvent {
        self.register_run(run_id);
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let event = NumberedEvent {
            run_id: run_id.to_string(),
            seq,
            event: TelemetryEvent {
                category: EventCategory::Lifecycle,
                name: name.to_string(),
                phase: EventPhase::Progress,
                message: format!("{name} 消息"),
                attributes: Default::default(),
            },
        };
        self.history
            .lock()
            .unwrap()
            .entry(run_id.to_string())
            .or_default()
            .push(event.clone());
        event
    }

    pub fn subscribe_count(&self) -> u64 {
        self.subscribe_count.load(Ordering::SeqCst)
    }

    pub fn closed_count(&self) -> u64 {
        self.closed_count.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl EventFeed for FakeEventFeed {
    fn subscribe(&self, run_id: &str) -> EventStream {
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        self.subscribe_count.fetch_add(1, Ordering::SeqCst);
        self.subscribers
            .lock()
            .unwrap()
            .entry(run_id.to_string())
            .or_default()
            .push(tx);
        rx
    }

    async fn read_since(
        &self,
        run_id: &str,
        after_seq: u64,
    ) -> Result<Vec<NumberedEvent>, ApiError> {
        if let Some(err) = self.faults.take("read_since") {
            return Err(err);
        }
        // 运行不存在与真实存储一致：返回 NotFound，SSE 握手即失败。
        // 已知运行但无事件：返回空历史。
        if !self.known_runs.lock().unwrap().contains(run_id) {
            return Err(ApiError::not_found(format!("运行 {run_id}")));
        }
        let history = self.history.lock().unwrap();
        Ok(history
            .get(run_id)
            .map(|events| {
                events
                    .iter()
                    .filter(|e| e.seq > after_seq)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default())
    }
}

// ---------------------------------------------------------------------------
// 工厂：组装 AppState
// ---------------------------------------------------------------------------

/// 组装测试用 AppState（MCP 装配 ops/control/internal 三域替身 backend）。
pub fn test_app_state(
    static_assets: crate::transport::StaticAssets,
) -> (
    crate::transport::AppState,
    std::sync::Arc<FakeWorkflows>,
    std::sync::Arc<FakeRoles>,
    std::sync::Arc<FakeRuns>,
    std::sync::Arc<FakeArtifacts>,
    std::sync::Arc<FakeSandboxes>,
    std::sync::Arc<FakeConnections>,
    std::sync::Arc<FakeEventFeed>,
) {
    let workflows = std::sync::Arc::new(FakeWorkflows::default());
    let roles = std::sync::Arc::new(FakeRoles::default());
    let runs = std::sync::Arc::new(FakeRuns::default());
    let artifacts = std::sync::Arc::new(FakeArtifacts::default());
    let sandboxes = std::sync::Arc::new(FakeSandboxes::default());
    let connections = std::sync::Arc::new(FakeConnections::default());
    let events = std::sync::Arc::new(FakeEventFeed::default());

    let mcp = crate::transport::mcp::assemble_mcp_server(&[
        ursi_mcp_server::Domain::Ops(std::sync::Arc::new(McpOpsStub)),
        ursi_mcp_server::Domain::Control(std::sync::Arc::new(McpControlStub::default())),
        ursi_mcp_server::Domain::Internal(std::sync::Arc::new(McpInternalStub::default())),
    ])
    .expect("MCP 替身装配成功");

    let state = crate::transport::AppState {
        workflows: workflows.clone(),
        roles: roles.clone(),
        runs: runs.clone(),
        artifacts: artifacts.clone(),
        sandboxes: sandboxes.clone(),
        connections: connections.clone(),
        events: events.clone(),
        mcp,
        static_assets: std::sync::Arc::new(static_assets),
    };
    (
        state,
        workflows,
        roles,
        runs,
        artifacts,
        sandboxes,
        connections,
        events,
    )
}

/// MCP 运维域替身：网关在线。
struct McpOpsStub;

#[async_trait]
impl ursi_mcp_server::OpsBackend for McpOpsStub {
    async fn list_sandboxes(
        &self,
        _run_id: Option<&str>,
    ) -> Result<Vec<ursi_mcp_server::SandboxSummary>, ursi_mcp_server::BackendFailure> {
        Ok(Vec::new())
    }

    async fn get_sandbox(
        &self,
        sandbox_id: &str,
    ) -> Result<ursi_mcp_server::SandboxSummary, ursi_mcp_server::BackendFailure> {
        Ok(ursi_mcp_server::SandboxSummary {
            sandbox_id: sandbox_id.into(),
            status: "running".into(),
            owner_run_id: "run-1".into(),
            endpoint: "10.0.0.1:22".into(),
        })
    }

    async fn restart_sandbox(
        &self,
        _sandbox_id: &str,
    ) -> Result<ursi_mcp_server::OpsOutcome, ursi_mcp_server::BackendFailure> {
        Ok(true)
    }

    async fn stop_sandbox(
        &self,
        _sandbox_id: &str,
    ) -> Result<ursi_mcp_server::OpsOutcome, ursi_mcp_server::BackendFailure> {
        Ok(true)
    }

    async fn gateway_status(
        &self,
    ) -> Result<ursi_mcp_server::GatewayStatus, ursi_mcp_server::BackendFailure> {
        Ok(ursi_mcp_server::GatewayStatus {
            reachable: true,
            detail: "ok".into(),
        })
    }
}

/// MCP 控制域替身：控制域工具面（run_id 从工具参数读取）。
struct McpControlStub {
    inner: ursi_mcp_server::stubs::RecordingControlBackend,
}

impl Default for McpControlStub {
    fn default() -> Self {
        McpControlStub {
            inner: ursi_mcp_server::stubs::recording_control_backend(),
        }
    }
}

#[async_trait]
impl ursi_mcp_server::ControlBackend for McpControlStub {
    async fn get_run(
        &self,
        run_id: &str,
    ) -> Result<ursi_mcp_server::RunSummary, ursi_mcp_server::BackendFailure> {
        self.inner.get_run(run_id).await
    }

    async fn list_runs(
        &self,
        status: Option<&str>,
    ) -> Result<Vec<ursi_mcp_server::RunSummary>, ursi_mcp_server::BackendFailure> {
        self.inner.list_runs(status).await
    }

    async fn cancel_run(
        &self,
        run_id: &str,
    ) -> Result<ursi_mcp_server::OpsOutcome, ursi_mcp_server::BackendFailure> {
        self.inner.cancel_run(run_id).await
    }

    async fn approve(
        &self,
        run_id: &str,
        node_id: &str,
        approved: bool,
    ) -> Result<ursi_mcp_server::OpsOutcome, ursi_mcp_server::BackendFailure> {
        self.inner.approve(run_id, node_id, approved).await
    }
}

/// MCP 内部域替身：带归属产物，用于越权场景。
struct McpInternalStub {
    inner: ursi_mcp_server::stubs::RecordingInternalBackend,
}

impl Default for McpInternalStub {
    fn default() -> Self {
        McpInternalStub {
            inner: ursi_mcp_server::stubs::recording_internal_backend(vec![
                ursi_mcp_server::ArtifactView {
                    artifact_id: "art-1".into(),
                    name: "报告".into(),
                    path: "out/report.md".into(),
                    owner_run_id: "run-1".into(),
                    owner_node_id: "node-a".into(),
                },
            ]),
        }
    }
}

#[async_trait]
impl ursi_mcp_server::InternalBackend for McpInternalStub {
    async fn get_run_status(
        &self,
        run_id: &str,
    ) -> Result<ursi_mcp_server::RunSummary, ursi_mcp_server::InternalBackendError> {
        self.inner.get_run_status(run_id).await
    }

    async fn list_nodes(
        &self,
        run_id: &str,
    ) -> Result<Vec<ursi_mcp_server::NodeSnapshot>, ursi_mcp_server::InternalBackendError> {
        self.inner.list_nodes(run_id).await
    }

    async fn get_artifact(
        &self,
        run_id: &str,
        artifact_id: &str,
    ) -> Result<ursi_mcp_server::ArtifactView, ursi_mcp_server::InternalBackendError> {
        self.inner.get_artifact(run_id, artifact_id).await
    }

    async fn list_artifacts(
        &self,
        run_id: &str,
    ) -> Result<Vec<ursi_mcp_server::ArtifactView>, ursi_mcp_server::InternalBackendError> {
        self.inner.list_artifacts(run_id).await
    }
}

/// 构造测试工作流定义。
pub fn sample_workflow(id: &str) -> WorkflowDefinition {
    ursi_domain::parse_workflow(&format!(
        r#"{{"id":"{id}","name":"demo","nodes":[{{"id":"n1","name":"第一步","type":"script","script":"echo hi"}}],"edges":[]}}"#
    ))
    .unwrap()
}

/// 构造测试角色 DTO。
pub fn sample_role(id: &str) -> RoleDto {
    RoleDto {
        id: id.into(),
        name: "评审员".into(),
        prompt: "严格评审".into(),
        model: Some("claude-sonnet".into()),
        skills: vec![crate::transport::ports::RoleSkillDto {
            path: "SKILL.md".into(),
            content: "# 评审".into(),
        }],
        mcp_servers: vec![crate::transport::ports::RoleMcpServerDto::Stdio {
            server: "fs".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "@modelcontextprotocol/server-fs".into()],
            env: vec![("TOKEN".into(), "{{cred:tok-main}}".into())],
        }],
        connection_id: "conn-main".into(),
        executor_kind: Some("cli:claude-code".into()),
    }
}
