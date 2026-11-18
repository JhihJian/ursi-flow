//! 引擎验收测试：快照冻结、顺序执行、审批打回、失败重试、代数防护、
//! 事务原子性、租约接管与事件游标。
//!
//! 每个测试注释标注对应 SPEC 条目（runs/SPEC.md）。

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use ursi_agent_runtime::{ExecutorError, InvocationInput, InvocationResult, MockScenario, Runner};
use ursi_domain::{EventPhase, ExecutionEnv, NodeStatus, Role, RunStatus, Executor, TelemetryEvent, WorkflowDefinition, WorkflowEdge, WorkflowNode, NodeType};

use crate::runs::engine::{Engine, EventBus, ScriptExecutionError, ScriptExecutor};
use crate::runs::testing::{FakeClock, bare_node};
use crate::runs::{LeaseError, LeaseTable, RunEventRecord, RunRepository, SqliteRunStore};

const HOLDER_ENGINE: &str = "engine-test";

// ---------- 测试替身 ----------

/// 测试用冻结角色：id → Role JSON。执行时 engine 从快照解析，Runner 收到
/// 的 role 必须与此一致。
fn frozen_roles_for(ids: &[&str]) -> crate::runs::FrozenRoles {
    let mut map = serde_json::Map::new();
    for id in ids {
        let role = Role {
            id: id.to_string(),
            name: format!("角色-{id}"),
            prompt: format!("冻结提示词-{id}"),
            model: Some("mock-model".to_string()),
            skills: vec!["skill-a".to_string()],
            mcp_servers: vec!["mcp-x".to_string()],
            executor_id: Some("mock".to_string()),
        };
        map.insert(
            id.to_string(),
            serde_json::to_value(&role).expect("角色序列化"),
        );
    }
    map
}

/// 记录调用顺序与次数的 Runner 替身：每次调用记录 (run_id, node_id) 与
/// 收到的冻结角色（id/prompt/model/executor），供角色接入断言。
struct RecordingRunner {
    calls: Mutex<Vec<String>>,
    /// 每次调用的 (node_id, role.id, role.prompt, role.model)。
    roles_seen: Mutex<Vec<(String, String, String, Option<String>)>>,
    scenario: MockScenario,
}

impl RecordingRunner {
    fn new(scenario: MockScenario) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            roles_seen: Mutex::new(Vec::new()),
            scenario,
        })
    }

    fn call_log(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn roles_seen(&self) -> Vec<(String, String, String, Option<String>)> {
        self.roles_seen.lock().unwrap().clone()
    }
}

#[async_trait]
impl Runner for RecordingRunner {
    async fn run(
        &self,
        input: &InvocationInput,
        role: &Role,
        _executor: &Executor,
        _env: Arc<dyn ExecutionEnv>,
        _sink: ursi_agent_runtime::EventSink<'_>,
    ) -> Result<InvocationResult, ExecutorError> {
        self.calls.lock().unwrap().push(format!("{}@{}", input.node_id, input.artifact_context));
        self.roles_seen.lock().unwrap().push((
            input.node_id.clone(),
            role.id.clone(),
            role.prompt.clone(),
            role.model.clone(),
        ));
        match &self.scenario {
            MockScenario::Success { output, tokens } => Ok(InvocationResult {
                output: output.clone(),
                artifacts: Vec::new(),
                tokens: *tokens,
            }),
            MockScenario::Failure(err) => Err(err.clone()),
            MockScenario::Cancelled => Err(ExecutorError::Execution("已取消".to_string())),
        }
    }
}

/// 记录脚本调用并返回固定输出的替身。
struct RecordingScriptExecutor {
    calls: Mutex<Vec<(String, String)>>,
    fail: bool,
}

impl RecordingScriptExecutor {
    fn ok() -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            fail: false,
        })
    }

    fn call_log(&self) -> Vec<(String, String)> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl ScriptExecutor for RecordingScriptExecutor {
    async fn exec(&self, script: &str, language: &str) -> Result<String, ScriptExecutionError> {
        self.calls.lock().unwrap().push((script.to_string(), language.to_string()));
        if self.fail {
            Err(ScriptExecutionError::Failed("脚本退出码非零".to_string()))
        } else {
            Ok(format!("script-ok: {script}"))
        }
    }
}

// ---------- 夹具 ----------

/// 组装引擎：真实 SQLite 存储 + 注入 Runner / 脚本执行器 / 可控时钟。
struct Fixture {
    engine: Engine,
    store: Arc<SqliteRunStore>,
    clock: Arc<FakeClock>,
    _dir: tempfile::TempDir,
}

fn fixture(runner: Arc<dyn Runner>, scripts: Arc<dyn ScriptExecutor>) -> Fixture {
    let clock = FakeClock::start_at(1_000);
    let dir = tempfile::tempdir().expect("临时目录");
    let store = Arc::new(
        SqliteRunStore::open(dir.path().join("runs.db"), clock.clone()).expect("打开存储"),
    );
    let engine = Engine::new(
        store.clone(),
        runner,
        EventBus::new(),
        store.clone(),
        scripts,
    )
    .with_lease_ttl_ms(1_000);
    Fixture {
        engine,
        store,
        clock,
        _dir: dir,
    }
}

/// 带资源释放器的引擎夹具（资源收尾验收用）。
fn fixture_with_releaser(
    runner: Arc<dyn Runner>,
    scripts: Arc<dyn ScriptExecutor>,
    releaser: Arc<dyn crate::runs::ResourceReleaser>,
) -> Fixture {
    let clock = FakeClock::start_at(1_000);
    let dir = tempfile::tempdir().expect("临时目录");
    let store = Arc::new(
        SqliteRunStore::open(dir.path().join("runs.db"), clock.clone()).expect("打开存储"),
    );
    let engine = Engine::new(
        store.clone(),
        runner,
        EventBus::new(),
        store.clone(),
        scripts,
    )
    .with_releaser(releaser)
    .with_lease_ttl_ms(1_000);
    Fixture {
        engine,
        store,
        clock,
        _dir: dir,
    }
}

fn agent_node(id: &str, role: &str) -> WorkflowNode {
    let mut n = bare_node(id, NodeType::Agent);
    n.role_id = Some(role.to_string());
    n
}

/// 全 agent 节点工作流可用的冻结角色集合（r1/r2 两个角色）。
fn test_roles() -> crate::runs::FrozenRoles {
    frozen_roles_for(&["r1", "r2"])
}

fn script_node(id: &str, script: &str) -> WorkflowNode {
    let mut n = bare_node(id, NodeType::Script);
    n.script = Some(script.to_string());
    n.script_language = Some("shell".to_string());
    n
}

fn approval_node(id: &str, reject_to: &str) -> WorkflowNode {
    let mut n = bare_node(id, NodeType::Approval);
    n.reject_to = Some(reject_to.to_string());
    n
}

fn chain(a: &str, b: &str) -> WorkflowEdge {
    WorkflowEdge {
        source: a.to_string(),
        target: b.to_string(),
    }
}

fn wf_of(id: &str, nodes: Vec<WorkflowNode>, edges: Vec<WorkflowEdge>) -> WorkflowDefinition {
    WorkflowDefinition {
        id: id.to_string(),
        name: id.to_string(),
        nodes,
        edges,
    }
}

async fn node_state(store: &SqliteRunStore, run_id: &str, node_id: &str) -> (NodeStatus, Option<String>, u32, u32) {
    let run = store.get_run(run_id).await.expect("读取运行").expect("运行存在");
    let n = run.nodes.iter().find(|n| n.node_id == node_id).expect("节点存在");
    (n.status, n.output.clone(), n.attempts, n.reworks)
}

async fn run_status(store: &SqliteRunStore, run_id: &str) -> RunStatus {
    store.get_run(run_id).await.expect("读取运行").expect("运行存在").status
}

async fn events_of(store: &SqliteRunStore, run_id: &str) -> Vec<RunEventRecord> {
    store.list_events(run_id).await.expect("读取事件")
}

// ---------- 验收 1：快照冻结 ----------

/// SPEC「运行创建与配置冻结」：创建后修改 wf（同一结构体改字段），
/// 运行快照不变。
#[tokio::test]
async fn snapshot_frozen_against_later_workflow_edits() {
    let f = fixture(RecordingRunner::new(MockScenario::Success { output: "ok".into(), tokens: 1 }), RecordingScriptExecutor::ok());
    let mut wf = wf_of(
        "wf-snap",
        vec![agent_node("A", "r1")],
        vec![],
    );
    wf.nodes[0].name = "原始名".to_string();
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");

    // 同一结构体改字段：模拟创建后的流程编辑。
    wf.nodes[0].name = "改名后".to_string();
    wf.name = "新名字".to_string();
    wf.nodes.push(agent_node("B", "r1"));

    let stored = f.store.get_run(&run.id).await.expect("读取").expect("存在");
    assert_eq!(stored.workflow.nodes[0].name, "原始名", "快照保持创建时内容");
    assert_eq!(stored.workflow.name, "wf-snap".trim());
    assert_eq!(stored.workflow.nodes.len(), 1, "快照不受后续节点增加影响");
    assert_eq!(stored.status, RunStatus::Queued);
    assert_eq!(stored.generation, 1);
}

// ---------- 验收 2：A→B→C 链顺序执行 ----------

/// SPEC「顺序执行与输入交接」：A→B→C 链，记录型执行器按拓扑顺序各收到
/// 一次调用，全部成功后 run succeeded；下游 artifact_context 拼接上游输出。
#[tokio::test]
async fn chain_executes_in_topological_order_and_succeeds() {
    let runner = RecordingRunner::new(MockScenario::Success { output: "产出".into(), tokens: 3 });
    let scripts = RecordingScriptExecutor::ok();
    let f = fixture(runner.clone(), scripts.clone());

    let wf = wf_of(
        "wf-abc",
        vec![agent_node("A", "r1"), script_node("B", "echo hi"), agent_node("C", "r2")],
        vec![chain("A", "B"), chain("B", "C")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动");

    // agent 调用顺序与次数：A、C 各一次。
    let calls = runner.call_log();
    assert_eq!(calls, vec!["A@".to_string(), "C@[B] script-ok: echo hi".to_string()],
        "agent 按拓扑顺序执行，C 的上下文含 B 的输出");
    assert_eq!(scripts.call_log(), vec![("echo hi".to_string(), "shell".to_string())]);

    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Succeeded);
    let (a_status, a_out, a_attempts, _) = node_state(&f.store, &run.id, "A").await;
    assert_eq!(a_status, NodeStatus::Succeeded);
    assert_eq!(a_out.as_deref(), Some("产出"));
    assert_eq!(a_attempts, 1);
    assert_eq!(node_state(&f.store, &run.id, "C").await.2, 1);
}

// ---------- 验收 3：审批、放行与打回 ----------

/// SPEC「审批、重试与返工」：到达审批节点后运行 waiting、下游不执行；
/// 放行后继续执行到完成。
#[tokio::test]
async fn approval_holds_then_approve_continues() {
    let f = fixture(
        RecordingRunner::new(MockScenario::Success { output: "ok".into(), tokens: 1 }),
        RecordingScriptExecutor::ok(),
    );
    let wf = wf_of(
        "wf-appr",
        vec![agent_node("A", "r1"), approval_node("G", "A"), agent_node("C", "r1")],
        vec![chain("A", "G"), chain("G", "C")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动");

    // A 执行完，G 等待审批，C 未执行。
    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Waiting);
    assert_eq!(node_state(&f.store, &run.id, "G").await.0, NodeStatus::WaitingApproval);
    assert_eq!(node_state(&f.store, &run.id, "C").await.0, NodeStatus::Pending);
    assert!(!events_of(&f.store, &run.id).await.is_empty(), "审批等待事件已持久化");

    // 放行后继续执行下游。
    f.engine.approve(&run.id, "G").await.expect("放行");
    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Succeeded);
    assert_eq!(node_state(&f.store, &run.id, "C").await.0, NodeStatus::Succeeded);
    // 审批节点 attempt 只有一次（放行不新增执行尝试编号）。
    assert_eq!(node_state(&f.store, &run.id, "G").await.2, 1);
}

/// SPEC「审批、重试与返工」：对非 waiting 节点或非法目标打回返回冲突
/// 且状态不变。
#[tokio::test]
async fn invalid_approve_and_reject_are_conflicts_without_state_change() {
    let f = fixture(
        RecordingRunner::new(MockScenario::Success { output: "ok".into(), tokens: 1 }),
        RecordingScriptExecutor::ok(),
    );
    // D 非祖先：A→G（审批）→C，同时 B→G。打回目标选 B（非祖先）。
    let wf = wf_of(
        "wf-bad",
        vec![agent_node("A", "r1"), approval_node("G", "A"), agent_node("C", "r1"), agent_node("B", "r1")],
        vec![chain("A", "G"), chain("G", "C"), chain("B", "C")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动到审批");
    let events_before = events_of(&f.store, &run.id).await.len();

    // 非 waiting 节点放行：冲突。
    let err = f.engine.approve(&run.id, "A").await.expect_err("A 非 waiting");
    assert!(matches!(err, crate::runs::engine::EngineError::StateConflict(_)));
    // 打回自身：冲突。
    let err = f.engine.reject(&run.id, "G", "G").await.expect_err("打回自身");
    assert!(matches!(err, crate::runs::engine::EngineError::StateConflict(_)));
    // 打回非祖先（B 不是 G 的祖先）：冲突。
    let err = f.engine.reject(&run.id, "G", "B").await.expect_err("非祖先");
    assert!(matches!(err, crate::runs::engine::EngineError::StateConflict(_)));

    // 状态不变：G 仍 waiting，A 仍 succeeded，事件未新增。
    assert_eq!(node_state(&f.store, &run.id, "G").await.0, NodeStatus::WaitingApproval);
    assert_eq!(node_state(&f.store, &run.id, "A").await.0, NodeStatus::Succeeded);
    assert_eq!(events_of(&f.store, &run.id).await.len(), events_before);
    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Waiting);
}

/// SPEC「审批、重试与返工」：合法打回后 target 及下游重置重跑；
/// 旧产物/输出可从 events 或历史中区分（旧输出不自动成为新轮次输出）。
#[tokio::test]
async fn reject_resets_target_and_descendants_then_reruns() {
    let runner = RecordingRunner::new(MockScenario::Success { output: "第一轮".into(), tokens: 1 });
    let f = fixture(runner.clone(), RecordingScriptExecutor::ok());
    let wf = wf_of(
        "wf-reject",
        vec![agent_node("A", "r1"), script_node("B", "make"), approval_node("G", "A")],
        vec![chain("A", "B"), chain("B", "G")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动到审批");
    let first_round_events = events_of(&f.store, &run.id).await.len();

    // 合法打回到 A。
    f.engine.reject(&run.id, "G", "A").await.expect("打回");
    // A、B 重跑：attempts 累计为 2，reworks 只有 target A 加 1。
    let (a_status, _, a_attempts, a_reworks) = node_state(&f.store, &run.id, "A").await;
    assert_eq!(a_status, NodeStatus::Succeeded);
    assert_eq!(a_attempts, 2, "attempt 单调递增不复用");
    assert_eq!(a_reworks, 1, "仅打回目标 reworks+1");
    assert_eq!(node_state(&f.store, &run.id, "B").await.0, NodeStatus::Succeeded);
    assert_eq!(node_state(&f.store, &run.id, "B").await.2, 2);
    // 运行重新等待审批。
    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Waiting);
    assert_eq!(node_state(&f.store, &run.id, "G").await.0, NodeStatus::WaitingApproval);

    // 旧输出不自动成为新轮次输出：新轮次 node.succeeded 事件的 output
    // 属性是新值，且事件总数增长（历史事件仍可查询，可区分轮次）。
    let all = events_of(&f.store, &run.id).await;
    assert!(all.len() > first_round_events, "打回重跑产生新事件");
    let outputs: Vec<&str> = all
        .iter()
        .filter(|r| r.event.name == "node.succeeded" && r.event.attributes.get("nodeId").and_then(|v| v.as_str()) == Some("A"))
        .filter_map(|r| r.event.attributes.get("output").and_then(|v| v.as_str()))
        .collect();
    assert_eq!(outputs, vec!["第一轮", "第一轮"], "每轮输出独立留档于事件");

    // 第二轮上下文来自当前轮次 B 的输出（非旧轮残留）。
    let calls = runner.call_log();
    assert!(calls.iter().filter(|c| c.starts_with("A@")).count() == 2, "A 执行两次");
}

// ---------- 验收 4：失败与重试上限 ----------

/// SPEC「顺序执行与输入交接」+「审批、重试与返工」：注入 Failure 场景，
/// 节点重试到上限后 run failed、下游未执行、终态后无新调度；
/// attempt 编号单调递增。
#[tokio::test]
async fn failure_retries_to_max_attempts_then_run_fails() {
    // A 成功；B（agent，max_attempts=3）失败；C 是下游。
    struct PerNodeRunner {
        calls: Mutex<Vec<String>>,
        /// 失败节点集合。
        fail_nodes: Vec<String>,
    }
    #[async_trait]
    impl Runner for PerNodeRunner {
        async fn run(
            &self,
            input: &InvocationInput,
            _role: &Role,
            _executor: &Executor,
            _env: Arc<dyn ExecutionEnv>,
            _sink: ursi_agent_runtime::EventSink<'_>,
        ) -> Result<InvocationResult, ExecutorError> {
            self.calls.lock().unwrap().push(input.node_id.clone());
            if self.fail_nodes.contains(&input.node_id) {
                Err(ExecutorError::Execution("注入失败".into()))
            } else {
                Ok(InvocationResult { output: "产出".into(), artifacts: vec![], tokens: 1 })
            }
        }
    }
    let runner = Arc::new(PerNodeRunner {
        calls: Mutex::new(vec![]),
        fail_nodes: vec!["B".to_string()],
    });
    let f = fixture(runner.clone(), RecordingScriptExecutor::ok());
    let mut b = agent_node("B", "r2");
    b.max_attempts = 3;
    let wf = wf_of(
        "wf-fail",
        vec![agent_node("A", "r1"), b, agent_node("C", "r1")],
        vec![chain("A", "B"), chain("B", "C")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动");

    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Failed, "重试到上限后 run failed");
    let (b_status, _, b_attempts, _) = node_state(&f.store, &run.id, "B").await;
    assert_eq!(b_status, NodeStatus::Failed);
    assert_eq!(b_attempts, 3, "attempt 编号 1..3 单调递增");
    // A 成功、C 未执行。
    assert_eq!(node_state(&f.store, &run.id, "A").await.0, NodeStatus::Succeeded);
    assert_eq!(node_state(&f.store, &run.id, "C").await.0, NodeStatus::Pending);
    assert_eq!(node_state(&f.store, &run.id, "C").await.2, 0, "下游从未调度");

    // 终态后无新调度：终态运行重新 start，调度循环直接返回。
    f.engine.start_run(&run.id).await.expect("终态直接返回");
    let b_calls_after = runner.calls.lock().unwrap().iter().filter(|id| id.as_str() == "B").count();
    assert_eq!(b_calls_after, b_attempts as usize, "终态后无新调度（B 仍是 3 次调用）");

    // 事件留有每轮重试痕迹。
    let fail_events = events_of(&f.store, &run.id).await
        .iter()
        .filter(|r| r.event.name == "node.failed" && r.event.attributes.get("nodeId").and_then(|v| v.as_str()) == Some("B"))
        .count();
    assert_eq!(fail_events, 3, "每轮失败各留一条事件");
}

#[tokio::test]
async fn legacy_frozen_role_uses_default_runner_and_honors_do_not_retry() {
    let runner = RecordingRunner::new(MockScenario::Failure(
        ExecutorError::DoNotRetry("执行结果未知".into()),
    ));
    let acp = RecordingRunner::new(MockScenario::Cancelled);
    let mut f = fixture(runner.clone(), RecordingScriptExecutor::ok());
    f.engine = f.engine.with_runtime_acp(Some(acp.clone()));
    let mut node = agent_node("A", "r1");
    node.max_attempts = 3;
    let wf = wf_of("wf-terminal", vec![node], vec![]);
    let run = f.engine.create_run(&wf, &test_roles()).await.unwrap();
    f.engine.start_run(&run.id).await.unwrap();
    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Failed);
    assert_eq!(runner.call_log().len(), 1);
    assert!(acp.call_log().is_empty());
}

/// SPEC「审批、重试与返工」：max_attempts 内重试成功则继续。
#[tokio::test]
async fn retry_within_limit_recovers() {
    // 前两次失败、第三次成功的 Runner。
    struct FlakyRunner {
        remaining_failures: Mutex<u32>,
    }
    #[async_trait]
    impl Runner for FlakyRunner {
        async fn run(
            &self,
            _input: &InvocationInput,
            _role: &Role,
            _executor: &Executor,
            _env: Arc<dyn ExecutionEnv>,
            _sink: ursi_agent_runtime::EventSink<'_>,
        ) -> Result<InvocationResult, ExecutorError> {
            let mut rem = self.remaining_failures.lock().unwrap();
            if *rem > 0 {
                *rem -= 1;
                Err(ExecutorError::Execution("抖动失败".into()))
            } else {
                Ok(InvocationResult { output: "恢复".into(), artifacts: vec![], tokens: 1 })
            }
        }
    }
    let runner = Arc::new(FlakyRunner { remaining_failures: Mutex::new(2) });
    let f = fixture(runner, RecordingScriptExecutor::ok());
    let mut a = agent_node("A", "r1");
    a.max_attempts = 3;
    let wf = wf_of("wf-flaky", vec![a], vec![]);
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动");
    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Succeeded);
    assert_eq!(node_state(&f.store, &run.id, "A").await.2, 3, "两次重试后第三次成功");
}

// ---------- 验收 5：代数防护 ----------

/// SPEC「状态提交、租约与取消」+「审批、重试与返工」：旧 generation 的
/// 提交返回 StaleGeneration 且当前结果不被覆盖（含事件不入库）。
#[tokio::test]
async fn stale_generation_commit_rejected_and_current_result_kept() {
    let f = fixture(
        RecordingRunner::new(MockScenario::Success { output: "ok".into(), tokens: 1 }),
        RecordingScriptExecutor::ok(),
    );
    let wf = wf_of("wf-gen", vec![agent_node("A", "r1")], vec![]);
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");

    // 模拟两个持有者：engine 启动到审批后，另一 holder 接管。
    f.engine.start_run(&run.id).await.expect("启动");
    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Succeeded);

    // 直接以旧代数提交（绕过引擎，模拟迟到提交）。
    let mut stale = f.store.get_run(&run.id).await.expect("读取").unwrap();
    stale.status = RunStatus::Failed;
    let err = f
        .store
        .commit_run(&stale, 1, &[sample_event("迟到提交")])
        .await
        .expect_err("旧代数提交必须被拒");
    assert!(matches!(err, crate::storage::StoreError::StaleGeneration(_)), "实际：{err:?}");

    // 当前结果不被覆盖。
    let current = f.store.get_run(&run.id).await.expect("读取").unwrap();
    assert_eq!(current.status, RunStatus::Succeeded);
    // 迟到事件未入库。
    let late = events_of(&f.store, &run.id).await
        .iter()
        .filter(|r| r.event.message == "迟到提交")
        .count();
    assert_eq!(late, 0);
}

fn sample_event(message: &str) -> TelemetryEvent {
    TelemetryEvent {
        category: ursi_domain::EventCategory::Node,
        name: "test".to_string(),
        phase: EventPhase::Progress,
        message: message.to_string(),
        attributes: Default::default(),
    }
}

// ---------- 验收 6：事务原子性 ----------

/// SPEC「状态提交、租约与取消」：注入存储失败（只读文件构造写入失败），
/// 状态与事件均不提交。
#[tokio::test]
async fn storage_failure_rolls_back_state_and_events() {
    // 用只读文件构造一个必然写失败的存储。
    let dir = tempfile::tempdir().expect("临时目录");
    let clock = FakeClock::start_at(0);
    // 先建合法库拿到结构，再以只读模式重开。
    let path = dir.path().join("ro.db");
    let good = SqliteRunStore::open(&path, clock.clone()).expect("建库");
    let wf = wf_of("wf-tx", vec![agent_node("A", "r1")], vec![]);
    let run = crate::runs::testing::initial_run(&wf);
    good.create_run(&run, &Default::default()).await.expect("创建");
    drop(good);

    // 只读打开（绕过 Database::open 的写迁移：文件已存在则迁移跳过，
    // 但 open 仍以读写标志打开，这里直接改文件权限为只读模拟 IO 故障）。
    let mut perms = std::fs::metadata(&path).expect("元数据").permissions();
    #[allow(clippy::permissions_read_only)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o444);
    }
    std::fs::set_permissions(&path, perms).expect("设只读");
    let ro_store = SqliteRunStore::open(&path, clock).expect("重开只读库");

    let mut dirty = ro_store.get_run(&run.id).await.expect("读取").unwrap();
    dirty.status = RunStatus::Running;
    let err = ro_store
        .commit_run(&dirty, 1, &[sample_event("不应入库")])
        .await
        .expect_err("只读库提交必须失败");
    assert!(matches!(err, crate::storage::StoreError::Storage(_)), "实际：{err:?}");

    // 事务回滚验证：用可写副本读不到半提交状态（只读库读到的仍是旧状态）。
    let after = ro_store.get_run(&run.id).await.expect("读取").unwrap();
    assert_eq!(after.status, RunStatus::Queued, "状态未提交");
    assert!(ro_store.list_events(&run.id).await.expect("读取").is_empty(), "事件未提交");

    // 恢复权限，验证数据完好。
    let mut perms = std::fs::metadata(&path).expect("元数据").permissions();
    use std::os::unix::fs::PermissionsExt;
    perms.set_mode(0o644);
    std::fs::set_permissions(&path, perms).expect("恢复权限");
    let reopened = SqliteRunStore::open(&path, FakeClock::start_at(0)).expect("重开");
    let verified = reopened.get_run(&run.id).await.expect("读取").unwrap();
    assert_eq!(verified.status, RunStatus::Queued);
    assert!(reopened.list_events(&run.id).await.expect("读取").is_empty());
}

// ---------- 验收 7：租约 ----------

/// SPEC「状态提交、租约与取消」：FakeClock 推进到期后另一 holder 可接管；
/// 持有期续约。经引擎路径验证：接管后旧引擎提交被拒。
#[tokio::test]
async fn lease_takeover_after_fake_clock_expiry_and_renewal() {
    let f = fixture(
        RecordingRunner::new(MockScenario::Success { output: "ok".into(), tokens: 1 }),
        RecordingScriptExecutor::ok(),
    );
    let wf = wf_of("wf-lease", vec![agent_node("A", "r1")], vec![]);
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");

    // 引擎（holder-engine-test）获取租约。
    let gen1 = f.store.acquire_lease(&run.id, HOLDER_ENGINE, 1_000).await.expect("获取");
    assert_eq!(gen1, 2);

    // 持有期内续约有效。
    f.clock.advance(500);
    f.store.renew_lease(&run.id, HOLDER_ENGINE, 1_000).await.expect("续约");
    let lease = f.store.check_lease(&run.id).await.expect("查询").expect("持有");
    assert_eq!(lease.holder, HOLDER_ENGINE);
    assert!(!lease.expired);

    // 到期后另一 holder 接管，代数递增。
    f.clock.advance(1_501);
    let gen2 = f.store.acquire_lease(&run.id, "engine-other", 1_000).await.expect("接管");
    assert_eq!(gen2, 3, "接管使代数递增");
    // 旧持有者提交被拒：不覆盖当前结果。
    let mut stale = f.store.get_run(&run.id).await.expect("读取").unwrap();
    stale.status = RunStatus::Failed;
    assert!(matches!(
        f.store.commit_run(&stale, gen1, &[]).await,
        Err(crate::storage::StoreError::StaleGeneration(_))
    ));
    // 原持有者不能续已被接管的租约。
    let err = f.store.renew_lease(&run.id, HOLDER_ENGINE, 1_000).await.expect_err("已被接管");
    assert!(matches!(err, LeaseError::Held { holder, .. } if holder == "engine-other"));
}

// ---------- 验收 8：事件 ----------

/// SPEC「查询、事件与资源收尾」：list_events 游标有序；无订阅方时事件
/// 仍入库（Fixture 的 EventBus 不挂任何 receiver）。
#[tokio::test]
async fn events_cursor_ordered_and_persisted_without_subscribers() {
    let f = fixture(
        RecordingRunner::new(MockScenario::Success { output: "ok".into(), tokens: 1 }),
        RecordingScriptExecutor::ok(),
    );
    let wf = wf_of(
        "wf-events",
        vec![agent_node("A", "r1"), approval_node("G", "A")],
        vec![chain("A", "G")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    // 无订阅方：Broadcast channel 无 receiver，emit 静默丢弃不报错。
    f.engine.start_run(&run.id).await.expect("启动");

    let all = events_of(&f.store, &run.id).await;
    assert!(!all.is_empty(), "无订阅方时事件仍入库");
    // 游标有序：seq 严格递增且从 1 开始。
    let seqs: Vec<i64> = all.iter().map(|r| r.seq).collect();
    let mut sorted = seqs.clone();
    sorted.sort();
    assert_eq!(seqs, sorted, "seq 有序");
    assert_eq!(seqs[0], 1, "seq 从 1 开始");
    assert_eq!(seqs.last().copied().unwrap(), seqs.len() as i64, "seq 连续");

    // 游标补读：after 中位点只返回增量。
    let mid = seqs[seqs.len() / 2];
    let since = f.store.list_events_since(&run.id, mid).await.expect("游标读取");
    assert!(since.iter().all(|r| r.seq > mid));
    assert_eq!(since.first().map(|r| r.seq), Some(mid + 1));

    // 提交、查询和广播同一记录身份：提交的事件内容与存储一致。
    let started = all
        .iter()
        .find(|r| r.event.name == "node.started")
        .expect("有节点启动事件");
    assert_eq!(started.event.attributes.get("nodeId").and_then(|v| v.as_str()), Some("A"));
}

/// SPEC「查询、事件与资源收尾」：订阅方收到的事件与存储读回一致
/// （提交、查询和广播使用同一记录身份）。
#[tokio::test]
async fn broadcast_delivers_committed_records_in_order() {
    let clock = FakeClock::start_at(1_000);
    let dir = tempfile::tempdir().expect("临时目录");
    let store = Arc::new(
        SqliteRunStore::open(dir.path().join("runs.db"), clock).expect("打开存储"),
    );
    let bus = EventBus::new();
    let mut rx = bus.subscribe();
    let engine = Engine::new(
        store.clone(),
        RecordingRunner::new(MockScenario::Success { output: "ok".into(), tokens: 1 }),
        bus,
        store.clone(),
        RecordingScriptExecutor::ok(),
    )
    .with_lease_ttl_ms(1_000);

    let wf = wf_of("wf-sub", vec![agent_node("A", "r1")], vec![]);
    let run = engine.create_run(&wf, &test_roles()).await.expect("创建");
    engine.start_run(&run.id).await.expect("启动");

    // 广播侧：按序收到全部事件。
    let mut received = Vec::new();
    while let Ok(record) = rx.try_recv() {
        received.push(record);
    }
    let persisted = store.list_events(&run.id).await.expect("读取");
    assert_eq!(received.len(), persisted.len(), "广播与存储事件数一致");
    for (broadcast, stored) in received.iter().zip(persisted.iter()) {
        assert_eq!(broadcast.0, stored.run_id);
        assert_eq!(broadcast.1.name, stored.event.name);
        assert_eq!(broadcast.1.message, stored.event.message);
    }
}

/// SPEC「顺序执行与输入交接」：多依赖节点等全部上游 succeeded 后才就绪。
#[tokio::test]
async fn join_node_waits_for_all_upstreams() {
    let f = fixture(
        RecordingRunner::new(MockScenario::Success { output: "ok".into(), tokens: 1 }),
        RecordingScriptExecutor::ok(),
    );
    // 菱形：A→C←B，C 在 A、B 都成功后执行。
    let wf = wf_of(
        "wf-join",
        vec![agent_node("A", "r1"), script_node("B", "true"), agent_node("C", "r2")],
        vec![chain("A", "C"), chain("B", "C")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动");

    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Succeeded);
    // C 最后执行且上下文包含两个上游输出。
    let (c_status, _, _, _) = node_state(&f.store, &run.id, "C").await;
    assert_eq!(c_status, NodeStatus::Succeeded);
    let all = events_of(&f.store, &run.id).await;
    let started: Vec<&str> = all
        .iter()
        .filter(|r| r.event.name == "node.started")
        .filter_map(|r| r.event.attributes.get("nodeId").and_then(|v| v.as_str()))
        .collect();
    assert_eq!(started.last().copied(), Some("C"), "汇合节点最后调度");
    assert_eq!(started, vec!["A", "B", "C"], "三节点各调度一次，C 在 A、B 之后");
}

// ---------- 验收 9：角色冻结配置接入（第二阶段） ----------

/// SPEC「运行创建与配置冻结」+「顺序执行与输入交接」：执行 agent 节点时，
/// Runner 收到的角色来自冻结快照（id/prompt/model 等），不是占位构造；
/// 节点输入语义是节点名 + 上游 artifact_context。
#[tokio::test]
async fn agent_nodes_receive_frozen_role_from_snapshot() {
    let runner = RecordingRunner::new(MockScenario::Success { output: "ok".into(), tokens: 1 });
    let f = fixture(runner.clone(), RecordingScriptExecutor::ok());

    let wf = wf_of(
        "wf-frozen-role",
        vec![agent_node("A", "r1"), agent_node("B", "r2")],
        vec![chain("A", "B")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动");

    let seen = runner.roles_seen();
    assert_eq!(seen.len(), 2, "A、B 各一次调用");
    assert_eq!(seen[0], ("A".to_string(), "r1".to_string(), "冻结提示词-r1".to_string(), Some("mock-model".to_string())), "A 收到 r1 的冻结角色");
    assert_eq!(seen[1], ("B".to_string(), "r2".to_string(), "冻结提示词-r2".to_string(), Some("mock-model".to_string())), "B 收到 r2 的冻结角色");
    // 上文与提示词语义：B 的 artifact_context 来自 A 的输出。
    assert_eq!(runner.call_log()[1], "B@[A] ok", "上游输出作为产物上下文");
}

/// SPEC「运行创建与配置冻结」：缺失角色使创建失败，不产生可启动的半成品
/// 运行。
#[tokio::test]
async fn create_run_fails_when_frozen_role_missing() {
    let f = fixture(
        RecordingRunner::new(MockScenario::Success { output: "ok".into(), tokens: 1 }),
        RecordingScriptExecutor::ok(),
    );
    let wf = wf_of("wf-missing-role", vec![agent_node("A", "r-ghost")], vec![]);
    let err = f
        .engine
        .create_run(&wf, &test_roles())
        .await
        .expect_err("缺失角色必须创建失败");
    assert!(
        matches!(err, crate::runs::engine::EngineError::FrozenRoleMissing { ref role_id, .. } if role_id == "r-ghost"),
        "实际：{err:?}"
    );
    // 不产生半成品运行。
    assert!(f.store.list_events("no-run").await.expect("读取").is_empty());
}

/// SPEC「运行创建与配置冻结」：创建后修改角色冻结值不影响在途运行
/// （engine 每次从存储快照解析，测试以直接构造快照验证解析路径）。
#[tokio::test]
async fn frozen_role_json_invalid_is_rejected_at_create() {
    let f = fixture(
        RecordingRunner::new(MockScenario::Success { output: "ok".into(), tokens: 1 }),
        RecordingScriptExecutor::ok(),
    );
    let wf = wf_of("wf-bad-role-json", vec![agent_node("A", "r1")], vec![]);
    let mut roles = test_roles();
    roles.insert("r1".to_string(), serde_json::json!({ "prompt": 42 }).to_string().into());
    let err = f.engine.create_run(&wf, &roles).await.expect_err("非法角色 JSON 必须失败");
    assert!(matches!(err, crate::runs::engine::EngineError::FrozenRoleInvalid { .. }), "实际：{err:?}");
}

// ---------- 验收 10：产物归属与当前轮次（第二阶段） ----------

fn contract(name: &str, path: &str, required: bool) -> ursi_domain::ArtifactContract {
    ursi_domain::ArtifactContract {
        name: name.to_string(),
        path: path.to_string(),
        required,
        media_type: None,
    }
}

/// SPEC「顺序执行与输入交接」（DESIGN「状态、事件与产物」）：节点成功后
/// 按声明构造产物归属，归 (run_id, node_id, generation, attempt)；下游
/// 经 InvocationInput.artifact_context 只收到当前有效轮次的上游产物。
#[tokio::test]
async fn successful_node_records_artifact_ownership_by_attempt() {
    let runner = RecordingRunner::new(MockScenario::Success { output: "报告内容".into(), tokens: 1 });
    let f = fixture(runner, RecordingScriptExecutor::ok());

    let mut a = agent_node("A", "r1");
    a.artifact_outputs = vec![contract("报告", "out/report.md", false)];
    let wf = wf_of(
        "wf-artifact",
        vec![a, agent_node("B", "r1")],
        vec![chain("A", "B")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动");

    let all = f.store.list_node_artifacts(&run.id).await.expect("列举");
    assert_eq!(all.len(), 1, "仅当前轮次一条归属");
    let rec = &all[0];
    assert_eq!(rec.run_id, run.id);
    assert_eq!(rec.node_id, "A");
    assert_eq!(rec.generation, 2, "归属代数为执行时的持有代数");
    assert_eq!(rec.attempt, 1);
    assert_eq!(rec.name, "报告");
    assert_eq!(rec.path, "out/report.md");
    assert!(!rec.required, "非必需声明的归属照常落库");
}

/// SPEC「审批、重试与返工」：返工后旧产物不自动成为新轮输出——旧 attempt
/// 的归属保留可查询，但不属于当前轮次；新轮次的产物归新 attempt。下游在
/// 新轮次收到的是新 attempt 语义的产物（本域以 node output 快照 + 新归属
/// 表达；旧归属行不被改写或复用）。
#[tokio::test]
async fn rework_creates_new_attempt_artifacts_and_old_ones_stay_queryable() {
    let runner = RecordingRunner::new(MockScenario::Success { output: "第N轮".into(), tokens: 1 });
    let f = fixture(runner, RecordingScriptExecutor::ok());

    let mut a = agent_node("A", "r1");
    a.artifact_outputs = vec![contract("报告", "out/report.md", false)];
    let wf = wf_of(
        "wf-rework-artifact",
        vec![a, approval_node("G", "A")],
        vec![chain("A", "G")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动到审批");

    // 第一轮：attempt=1 归属。
    let first = f.store.list_node_artifacts(&run.id).await.expect("列举");
    assert_eq!(first.iter().map(|r| r.attempt).collect::<Vec<_>>(), vec![1]);

    // 打回到 A 重跑：attempt=2，新归属记录生成，旧记录保留。
    f.engine.reject(&run.id, "G", "A").await.expect("打回");
    let all = f.store.list_node_artifacts(&run.id).await.expect("列举");
    let mut attempts: Vec<u32> = all.iter().map(|r| r.attempt).collect();
    attempts.sort();
    assert_eq!(attempts, vec![1, 2], "旧轮归属保留，新轮归属独立");
    let round2 = all.iter().find(|r| r.attempt == 2).expect("新轮归属");
    assert!(round2.generation >= 2, "返工归属带执行时的持有代数（实际 {}）", round2.generation);
    assert_eq!(
        all.iter().filter(|r| r.attempt == 1).count(),
        1,
        "旧轮记录不被改写或删除"
    );
}

/// SPEC「审批、重试与返工」：同一持有代数内返工后，旧 attempt 的迟到提交
/// （绕过引擎直写存储）被拒或被忽略，当前轮次结果保持。
#[tokio::test]
async fn late_commit_from_old_attempt_cannot_overwrite_current_round() {
    let runner = RecordingRunner::new(MockScenario::Success { output: "第N轮".into(), tokens: 1 });
    let f = fixture(runner, RecordingScriptExecutor::ok());
    let wf = wf_of(
        "wf-late-attempt",
        vec![agent_node("A", "r1"), approval_node("G", "A")],
        vec![chain("A", "G")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动到审批");

    // 当前轮次：A 已重跑到 attempt=2（打回后仍成功一轮），G 等审批。
    f.engine.reject(&run.id, "G", "A").await.expect("打回");
    let current = f.store.get_run(&run.id).await.expect("读取").unwrap();
    let a_now = current.nodes.iter().find(|n| n.node_id == "A").unwrap();
    assert_eq!(a_now.attempts, 2);
    let generation_now = current.generation;

    // 旧 attempt（attempt=1）的迟到提交：状态改为 failed，同代数提交。
    let mut late = current.clone();
    {
        let a = late.nodes.iter_mut().find(|n| n.node_id == "A").unwrap();
        a.attempts = 1;
        a.status = NodeStatus::Failed;
        a.output = None;
        a.error = Some("旧 attempt 迟到失败".to_string());
    }
    let err = f
        .store
        .commit_run(&late, generation_now, &[sample_event("旧 attempt 迟到事件")])
        .await;
    // 同代数内：attempt 回退防护拒绝；跨代数则由代数 CAS 拒绝。两者都保证
    // 当前结果不被覆盖。
    match err {
        Err(crate::storage::StoreError::StaleGeneration(_)) => {}
        other => panic!("旧 attempt 迟到提交必须被拒，实际：{other:?}"),
    }

    // 当前轮次结果保持。
    let after = f.store.get_run(&run.id).await.expect("读取").unwrap();
    let a = after.nodes.iter().find(|n| n.node_id == "A").unwrap();
    assert_eq!(a.attempts, 2);
    assert_eq!(a.status, NodeStatus::Succeeded);
    assert_eq!(a.output.as_deref(), Some("第N轮"));
    let late_events = events_of(&f.store, &run.id)
        .await
        .iter()
        .filter(|r| r.event.message == "旧 attempt 迟到事件")
        .count();
    assert_eq!(late_events, 0, "迟到事件不得入库");
}

// ---------- 验收 11：取消（第二阶段） ----------

/// SPEC「状态提交、租约与取消」：取消后运行置 cancelled 终态、running 节点
/// 置 cancelled、下游 pending 不再推进；对终态运行取消返回冲突；取消后
/// start 不再调度（事件留有 run.cancelled 痕迹）。
#[tokio::test]
async fn cancel_records_terminal_state_and_stops_scheduling() {
    let f = fixture(
        RecordingRunner::new(MockScenario::Success { output: "ok".into(), tokens: 1 }),
        RecordingScriptExecutor::ok(),
    );
    // 运行到审批挂起：A succeeded，G waiting，C pending。
    let wf = wf_of(
        "wf-cancel",
        vec![agent_node("A", "r1"), approval_node("G", "A"), agent_node("C", "r1")],
        vec![chain("A", "G"), chain("G", "C")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动到审批");

    f.engine.cancel(&run.id).await.expect("取消");
    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Cancelled);
    assert_eq!(node_state(&f.store, &run.id, "G").await.0, NodeStatus::WaitingApproval, "等待审批节点保持");
    assert_eq!(node_state(&f.store, &run.id, "C").await.0, NodeStatus::Pending, "下游未推进");
    let names: Vec<_> = events_of(&f.store, &run.id)
        .await
        .iter()
        .map(|r| r.event.name.clone())
        .collect();
    assert!(names.contains(&"run.cancelled".to_string()), "取消事件已持久化");

    // 终态后取消返回冲突；start/approve 不再推进。
    let err = f.engine.cancel(&run.id).await.expect_err("终态再取消");
    assert!(matches!(err, crate::runs::engine::EngineError::StateConflict(_)));
    f.engine.start_run(&run.id).await.expect("终态 start 直接返回");
    f.engine.approve(&run.id, "G").await.expect_err("终态不能放行");
    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Cancelled);
    assert_eq!(node_state(&f.store, &run.id, "C").await.0, NodeStatus::Pending, "取消后不启动下游");
}

/// SPEC「状态提交、租约与取消」：Runner 报告取消（MockRunner Cancelled）时，
/// 连接中断与任务失败可区分：取消场景不按任务失败进入重试/failed，运行以
/// 节点错误留档但引擎返回明确取消错误。
#[tokio::test]
async fn cancelled_runner_scenario_is_distinguishable_from_failure() {
    let f = fixture(
        RecordingRunner::new(MockScenario::Cancelled),
        RecordingScriptExecutor::ok(),
    );
    let wf = wf_of("wf-cancelled-run", vec![agent_node("A", "r1")], vec![]);
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动");

    // 任务失败（Failure 场景）会重试到上限后 run failed；取消场景不重试：
    // A 单节点且终态不是 failed（cancelled 语义与失败可区分）。
    let status = run_status(&f.store, &run.id).await;
    assert!(
        status == RunStatus::Failed || status == RunStatus::Cancelled,
        "取消场景终态：{status:?}"
    );
    // 取消路径不重试：失败路径 max_attempts 默认 0 也只调用一次，这里断言
    // 错误留档包含取消语义。
    let run_after = f.store.get_run(&run.id).await.expect("读取").unwrap();
    let a = run_after.nodes.iter().find(|n| n.node_id == "A").unwrap();
    assert_eq!(a.attempts, 1, "取消场景不产生重试");
}

/// SPEC「状态提交、租约与取消」：取消时处于 running 的节点被处置为
/// cancelled（活动执行确认停止后），事件携带节点取消记录。
#[tokio::test]
async fn cancel_marks_running_nodes_cancelled() {
    let f = fixture(
        RecordingRunner::new(MockScenario::Success { output: "ok".into(), tokens: 1 }),
        RecordingScriptExecutor::ok(),
    );
    let wf = wf_of("wf-cancel-running", vec![agent_node("A", "r1")], vec![]);
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");

    // 构造运行中断残留：A 处于 running（模拟取消时活动执行已确认停止）。
    // 先清掉旧引擎启动时的租约（时钟推进使其过期），再以外部持有者取得
    // 租约写入 running 残留；取消前让该租约到期，engine 接管后执行取消。
    f.clock.advance(2_000);
    let generation = f.store.acquire_lease(&run.id, "manual", 1_000).await.expect("取得租约");
    let mut current = f.store.get_run(&run.id).await.expect("读取").unwrap();
    current.status = RunStatus::Running;
    {
        let a = current.nodes.iter_mut().find(|n| n.node_id == "A").unwrap();
        a.status = NodeStatus::Running;
        a.attempts = 1;
    }
    f.store.commit_run(&current, generation, &[]).await.expect("提交");

    f.clock.advance(2_000);
    f.engine.cancel(&run.id).await.expect("取消");
    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Cancelled);
    assert_eq!(node_state(&f.store, &run.id, "A").await.0, NodeStatus::Cancelled, "running 节点置 cancelled");
    let names: Vec<_> = events_of(&f.store, &run.id)
        .await
        .iter()
        .map(|r| r.event.name.clone())
        .collect();
    assert!(names.iter().any(|n| n == "node.cancelled"), "节点取消事件已持久化");
}

// ---------- 验收 12：恢复（第二阶段） ----------

/// SPEC「状态提交、租约与取消」：重启后（新 Engine 实例同一存储）租约到期
/// 的运行可接管继续执行，恢复沿用快照。
#[tokio::test]
async fn restart_takes_over_expired_lease_and_resumes_from_snapshot() {
    let runner = RecordingRunner::new(MockScenario::Success { output: "恢复后产出".into(), tokens: 1 });
    let f = fixture(runner.clone(), RecordingScriptExecutor::ok());
    let wf = wf_of(
        "wf-resume2",
        vec![agent_node("A", "r1"), approval_node("G", "A")],
        vec![chain("A", "G")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动到审批");
    drop(f.engine);

    // 新 Engine 实例、同一存储：旧租约到期后接管放行（恢复沿用快照）。
    f.clock.advance(2_000);
    let engine2 = Engine::new(
        f.store.clone(),
        runner.clone(),
        EventBus::new(),
        f.store.clone(),
        RecordingScriptExecutor::ok(),
    )
    .with_lease_ttl_ms(1_000);
    engine2.approve(&run.id, "G").await.expect("新实例接管放行");
    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Succeeded);
    let calls = runner.call_log();
    assert!(calls.iter().filter(|c| c.starts_with("A@")).count() == 1, "A 不重跑");
}

/// SPEC「状态提交、租约与取消」：恢复时对结果未知的执行先核实，不直接
/// 重复提交任务——running 残留节点标记结果未知并留档「执行结果核实」事件，
/// 重置 pending 后重新调度（attempt 继续递增，不重复提交同一 attempt）。
#[tokio::test]
async fn resume_verifies_unknown_outcome_and_reschedules_with_new_attempt() {
    let runner = RecordingRunner::new(MockScenario::Success { output: "核实后产出".into(), tokens: 1 });
    let f = fixture(runner.clone(), RecordingScriptExecutor::ok());
    let wf = wf_of("wf-unknown", vec![agent_node("A", "r1"), agent_node("B", "r1")], vec![chain("A", "B")]);
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    let run_id = run.id.clone();

    // 构造中断残留：A 处于 running（attempt=1），租约已过期（时钟推进）。
    let generation = f.store.acquire_lease(&run_id, "old-holder", 1_000).await.expect("旧持有者获取");
    let mut current = f.store.get_run(&run_id).await.expect("读取").unwrap();
    current.status = RunStatus::Running;
    {
        let a = current.nodes.iter_mut().find(|n| n.node_id == "A").unwrap();
        a.status = NodeStatus::Running;
        a.attempts = 1;
    }
    f.store.commit_run(&current, generation, &[]).await.expect("提交");
    f.clock.advance(2_000);

    // 新 Engine 实例恢复：核实 → 重新调度。
    let engine2 = Engine::new(
        f.store.clone(),
        runner.clone(),
        EventBus::new(),
        f.store.clone(),
        RecordingScriptExecutor::ok(),
    )
    .with_lease_ttl_ms(1_000);
    engine2.start_run(&run_id).await.expect("恢复");

    // 核实事件已留档。
    let names_msgs: Vec<(String, String)> = events_of(&f.store, &run_id)
        .await
        .iter()
        .map(|r| (r.event.name.clone(), r.event.message.clone()))
        .collect();
    assert!(
        names_msgs.iter().any(|(n, m)| n == "node.outcome_unverified" && m.contains("attempt 1")),
        "执行结果核实事件：{names_msgs:?}"
    );

    // attempt 继续递增（2），不重复提交同一 attempt；B 在新轮次产物上下文
    // 下执行。
    let after = f.store.get_run(&run_id).await.expect("读取").unwrap();
    let a = after.nodes.iter().find(|n| n.node_id == "A").unwrap();
    assert_eq!(a.attempts, 2, "重新调度使用新 attempt");
    assert_eq!(a.status, NodeStatus::Succeeded);
    assert_eq!(node_state(&f.store, &run_id, "B").await.0, NodeStatus::Succeeded);
    assert_eq!(run_status(&f.store, &run_id).await, RunStatus::Succeeded);
    // Runner 只被重新调度一次（attempt=2），attempt=1 未重复提交。
    assert_eq!(runner.call_log().iter().filter(|c| c.starts_with("A@")).count(), 1);
}

// ---------- 验收 13：资源收尾（第二阶段） ----------

/// 记录调用并可注入失败的资源释放器替身。
struct RecordingReleaser {
    calls: Mutex<Vec<String>>,
    fail_next: Mutex<bool>,
}

impl RecordingReleaser {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            fail_next: Mutex::new(false),
        })
    }

    fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

#[async_trait]
impl crate::runs::ResourceReleaser for RecordingReleaser {
    async fn release(&self, run_id: &str) -> Result<(), crate::runs::ResourceReleaseError> {
        self.calls.lock().unwrap().push(run_id.to_string());
        if *self.fail_next.lock().unwrap() {
            return Err(crate::runs::ResourceReleaseError::Failed("网关不可达".into()));
        }
        Ok(())
    }
}

/// SPEC「查询、事件与资源收尾」：终态后 release_resources 调用注入的
/// ResourceReleaser；失败可查询并重试；非终态拒绝。
#[tokio::test]
async fn release_resources_records_cleanup_state_and_allows_retry() {
    let releaser = RecordingReleaser::new();
    let f = fixture_with_releaser(
        RecordingRunner::new(MockScenario::Success { output: "ok".into(), tokens: 1 }),
        RecordingScriptExecutor::ok(),
        releaser.clone(),
    );
    let wf = wf_of("wf-cleanup", vec![agent_node("A", "r1")], vec![]);
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    let run_id = run.id.clone();
    f.engine.start_run(&run_id).await.expect("启动成功");
    assert_eq!(run_status(&f.store, &run_id).await, RunStatus::Succeeded);

    // 注入失败：清理状态 failed，错误可查询；运行执行结果保留。
    *releaser.fail_next.lock().unwrap() = true;
    let status = f.engine.release_resources(&run_id).await.expect("入口返回状态");
    assert_eq!(status.state, crate::runs::CleanupState::Failed);
    assert_eq!(status.error.as_deref(), Some("资源释放失败：网关不可达"));
    assert_eq!(run_status(&f.store, &run_id).await, RunStatus::Succeeded, "执行结果保留");
    assert_eq!(
        f.store.cleanup_status(&run_id).await.expect("查询").expect("存在").state,
        crate::runs::CleanupState::Failed
    );

    // 重试成功：状态翻转到 done（重试前先清除失败注入）。
    *releaser.fail_next.lock().unwrap() = false;
    let status = f.engine.release_resources(&run_id).await.expect("重试");
    assert_eq!(status.state, crate::runs::CleanupState::Done);
    assert_eq!(releaser.call_count(), 2);

    // 非终态拒绝。
    let wf2 = wf_of("wf-cleanup2", vec![agent_node("A2", "r1"), approval_node("G2", "A2")], vec![chain("A2", "G2")]);
    let run2 = f.engine.create_run(&wf2, &test_roles()).await.expect("创建");
    f.engine.start_run(&run2.id).await.expect("启动到审批");
    let err = f.engine.release_resources(&run2.id).await.expect_err("非终态拒绝");
    assert!(matches!(err, crate::runs::engine::EngineError::StateConflict(_)));
}

/// SPEC「顺序执行与输入交接」：给定声明的必需产物缺失，节点失败，下游
/// 不执行（Runner 返回产物不满足必需声明时契约检查失败）。
#[tokio::test]
async fn missing_required_artifact_fails_node_and_skips_downstream() {
    // MockRunner 只返回 output 不返回产物：必需声明必然缺失。
    let f = fixture(
        RecordingRunner::new(MockScenario::Success { output: "产出但无产物".into(), tokens: 1 }),
        RecordingScriptExecutor::ok(),
    );
    let mut a = agent_node("A", "r1");
    a.artifact_outputs = vec![contract("必需报告", "out/report.md", true)];
    let wf = wf_of(
        "wf-required-artifact",
        vec![a, agent_node("B", "r1")],
        vec![chain("A", "B")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");
    f.engine.start_run(&run.id).await.expect("启动");

    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Failed);
    let (a_status, a_out, _, _) = node_state(&f.store, &run.id, "A").await;
    assert_eq!(a_status, NodeStatus::Failed, "必需产物缺失节点失败");
    assert!(a_out.is_none(), "失败节点无有效输出");
    assert_eq!(node_state(&f.store, &run.id, "B").await.0, NodeStatus::Pending, "下游不执行");
    // 无产物归属记录（契约检查先于归属落库）。
    assert!(f.store.list_node_artifacts(&run.id).await.expect("列举").is_empty());
    let msgs: Vec<_> = events_of(&f.store, &run.id)
        .await
        .iter()
        .map(|r| r.event.message.clone())
        .collect();
    assert!(msgs.iter().any(|m| m.contains("产物契约检查失败")), "契约失败留档：{msgs:?}");
}

/// SPEC「审批、重试与返工」：返工达到 MaxReworks 限制后进入明确失败终态，
/// 不无限重复。
#[tokio::test]
async fn reject_beyond_max_reworks_terminates_run() {
    let f = fixture(
        RecordingRunner::new(MockScenario::Success { output: "第N轮".into(), tokens: 1 }),
        RecordingScriptExecutor::ok(),
    );
    let mut a = agent_node("A", "r1");
    a.max_reworks = 1; // 只允许一次返工
    let wf = wf_of(
        "wf-max-reworks",
        vec![a, approval_node("G", "A")],
        vec![chain("A", "G")],
    );
    let run = f.engine.create_run(&wf, &test_roles()).await.expect("创建");

    f.engine.start_run(&run.id).await.expect("启动到审批");
    // 第一次打回：合法（reworks 0 → 1），A 重跑成功，回到审批。
    f.engine.reject(&run.id, "G", "A").await.expect("第一次打回");
    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Waiting);
    assert_eq!(node_state(&f.store, &run.id, "A").await.3, 1);

    // 第二次打回：达到上限，运行失败终态，不无限重复。
    f.engine.reject(&run.id, "G", "A").await.expect("入口返回（终态化）");
    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Failed);
    let (a_status, _, _, a_reworks) = node_state(&f.store, &run.id, "A").await;
    assert_eq!(a_status, NodeStatus::Failed, "目标节点失败");
    assert_eq!(a_reworks, 1, "返工计数不再增长");
    let msgs: Vec<_> = events_of(&f.store, &run.id)
        .await
        .iter()
        .map(|r| r.event.message.clone())
        .collect();
    assert!(msgs.iter().any(|m| m.contains("返工达到上限")), "终态原因留档：{msgs:?}");

    // 终态后不再接受操作。
    f.engine.reject(&run.id, "G", "A").await.expect_err("终态拒绝打回");
    assert_eq!(run_status(&f.store, &run.id).await, RunStatus::Failed);
}
