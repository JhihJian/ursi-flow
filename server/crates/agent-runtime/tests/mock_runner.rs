//! MockRunner 集成测试：确定性、失败注入、事件回流、sink 弱引用语义。
//!
//! SPEC 验收（事件回流）：执行期间持续收到属于当前会话的事件，终态与
//! 最终结果一致；观测消费者缺失不会阻止控制请求和结果返回。

use std::sync::{Arc, Mutex};

use ursi_agent_runtime::{ExecutorError, InvocationInput, MockRunner, MockScenario, Runner};
use ursi_domain::{EventCategory, EventPhase, ExecutionEnv, Role, TelemetryEvent};

/// 空执行环境：mock 不触碰环境，占位满足 Runner 签名。
struct NoEnv;

#[async_trait::async_trait]
impl ExecutionEnv for NoEnv {
    async fn exec(&self, _cmd: &str) -> Result<(i32, String), ursi_domain::EnvError> {
        Err(ursi_domain::EnvError::Other("mock 不执行命令".to_string()))
    }
    async fn write_file(&self, _path: &str, _content: &[u8]) -> Result<(), ursi_domain::EnvError> {
        Err(ursi_domain::EnvError::Other("mock 不写文件".to_string()))
    }
    async fn read_file(&self, _path: &str) -> Result<Vec<u8>, ursi_domain::EnvError> {
        Err(ursi_domain::EnvError::FileNotFound(_path.to_string()))
    }
}

fn test_role() -> Role {
    Role {
        id: "reviewer".to_string(),
        name: "评审员".to_string(),
        prompt: "严格评审".to_string(),
        model: None,
        skills: vec![],
        mcp_servers: vec![],
        executor_id: None,
    }
}

fn test_executor() -> ursi_domain::Executor {
    ursi_domain::Executor {
        id: "mock-1".to_string(),
        name: "Mock 执行器".to_string(),
        kind: ursi_domain::ExecutorKind::Mock,
    }
}

fn test_input() -> InvocationInput {
    InvocationInput {
        prompt: "审查代码".to_string(),
        artifact_context: String::new(),
        run_id: "run-9".to_string(),
        node_id: "node-9".to_string(),
    }
}

/// SPEC 验收（事件回流 / MockRunner）：确定性——同配置多次执行结果一致。
#[tokio::test]
async fn mock_runner_is_deterministic_across_runs() {
    let runner = MockRunner::new(MockScenario::Success {
        output: "固定输出".to_string(),
        tokens: 42,
    });
    let role = test_role();
    let executor = test_executor();
    let env: Arc<dyn ExecutionEnv> = Arc::new(NoEnv);
    let sink = |_: TelemetryEvent| {};

    let first = runner
        .run(&test_input(), &role, &executor, env.clone(), &sink)
        .await
        .expect("第一次执行失败");
    let second = runner
        .run(&test_input(), &role, &executor, env.clone(), &sink)
        .await
        .expect("第二次执行失败");

    assert_eq!(first.output, "固定输出");
    assert_eq!(second.output, first.output, "同配置输出确定");
    assert_eq!(first.tokens, 42);
    assert_eq!(second.tokens, first.tokens, "同配置 tokens 确定");
    assert_eq!(first.artifacts.len(), second.artifacts.len());
    assert_eq!(runner.run_count(), 2, "执行计数确定");
}

/// SPEC 验收（事件回流 / MockRunner）：失败注入可识别——错误变体原样透出。
#[tokio::test]
async fn injected_failure_is_identifiable() {
    let runner = MockRunner::new(MockScenario::Failure(ExecutorError::Parse(
        "输出无法解析".to_string(),
    )));
    let role = test_role();
    let executor = test_executor();
    let env: Arc<dyn ExecutionEnv> = Arc::new(NoEnv);
    let sink = |_: TelemetryEvent| {};

    let err = runner
        .run(&test_input(), &role, &executor, env.clone(), &sink)
        .await
        .expect_err("注入失败应返回错误");
    assert!(
        matches!(err, ExecutorError::Parse(ref m) if m.contains("输出无法解析")),
        "失败变体可识别，实际 {err:?}"
    );

    // 取消场景：注入的取消以 Execution 错误描述，可识别。
    let cancelled = MockRunner::new(MockScenario::Cancelled);
    let err = cancelled
        .run(&test_input(), &role, &executor, env.clone(), &sink)
        .await
        .expect_err("取消场景应返回错误");
    assert!(
        matches!(err, ExecutorError::Execution(ref m) if m.contains("取消")),
        "取消注入可识别，实际 {err:?}"
    );
}

/// SPEC 验收（事件回流 / MockRunner）：事件经 sink 回流且携带关联标识。
#[tokio::test]
async fn events_flow_back_through_sink_with_correlation() {
    let custom = TelemetryEvent {
        category: EventCategory::Tool,
        name: "mock.tool".to_string(),
        phase: EventPhase::Start,
        message: "mock 工具调用".to_string(),
        attributes: Default::default(),
    };
    let runner = MockRunner::new(MockScenario::Success {
        output: "完成".to_string(),
        tokens: 7,
    })
    .with_events(vec![custom]);
    let role = test_role();
    let executor = test_executor();
    let env: Arc<dyn ExecutionEnv> = Arc::new(NoEnv);

    let events = Arc::new(Mutex::new(Vec::<TelemetryEvent>::new()));
    let events_for_sink = events.clone();
    let sink = move |event: TelemetryEvent| {
        events_for_sink.lock().unwrap().push(event);
    };

    let result = runner
        .run(&test_input(), &role, &executor, env, &sink)
        .await
        .expect("执行失败");

    let got = events.lock().unwrap();
    assert_eq!(got.len(), 1, "注入的事件应全部回流");
    assert_eq!(got[0].name, "mock.tool");
    // 关联标识贯穿：事件属性携带 run_id/node_id。
    assert_eq!(
        got[0].attributes.get("runId").and_then(|v| v.as_str()),
        Some("run-9")
    );
    assert_eq!(
        got[0].attributes.get("nodeId").and_then(|v| v.as_str()),
        Some("node-9")
    );
    // 终态与结果一致：事件回流的同时结果照常返回。
    assert_eq!(result.output, "完成");
    assert_eq!(result.tokens, 7);
}

/// SPEC 验收（事件回流 / MockRunner）：sink 为弱引用，不影响结果返回；
/// 观测消费者缺失不会阻止控制请求和结果返回。
#[tokio::test]
async fn weak_sink_does_not_block_result_and_missing_consumer_is_fine() {
    let runner = MockRunner::new(MockScenario::Success {
        output: "无消费者也完成".to_string(),
        tokens: 3,
    });
    let role = test_role();
    let executor = test_executor();
    let env: Arc<dyn ExecutionEnv> = Arc::new(NoEnv);

    // 消费者缺失（sink 计数为 0）：传入立即丢弃的空回调，执行照常完成。
    let sink = |_: TelemetryEvent| {};
    let result = runner
        .run(&test_input(), &role, &executor, env, &sink)
        .await
        .expect("执行失败");
    assert_eq!(result.output, "无消费者也完成");
    assert_eq!(result.tokens, 3);
    assert_eq!(runner.run_count(), 1);
}

/// SPEC 验收（事件回流 / MockRunner）：sink 闭包不阻塞执行——回流调用
/// 同步完成，执行在事件之后照常返回结果（弱引用语义的行为验证）。
#[tokio::test]
async fn sink_invocation_does_not_delay_or_break_result() {
    let runner = MockRunner::new(MockScenario::Success {
        output: "顺序无关".to_string(),
        tokens: 1,
    });
    let role = test_role();
    let executor = test_executor();
    let env: Arc<dyn ExecutionEnv> = Arc::new(NoEnv);

    // 闭包捕获外部状态做计数，验证回流确实发生但不影响返回值。
    let count = Arc::new(Mutex::new(0usize));
    let count_for_sink = count.clone();
    let sink = move |_: TelemetryEvent| {
        *count_for_sink.lock().unwrap() += 1;
    };
    let result = runner
        .run(&test_input(), &role, &executor, env, &sink)
        .await
        .expect("执行失败");
    assert_eq!(*count.lock().unwrap(), 3, "默认 3 条事件都回流");
    assert_eq!(result.output, "顺序无关");
}
