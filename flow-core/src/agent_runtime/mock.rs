//! MockRunner：确定性 mock 执行器实现，供测试与演示装配方使用。
//!
//! 通过 [`MockScenario`] 注入成功 / 失败 / 取消场景，token 消耗可配置，
//! 事件经 sink 同步回流。 [`EventSink`] 是弱引用语义的同步回调：调用即
//! 返回，不阻塞、不影响结果返回，消费者缺失不阻止执行完成。
//!
//! SPEC 验收（事件回流）：执行期间持续收到属于当前会话的事件，终态与
//! 最终结果一致；观测消费者缺失不会阻止控制请求和结果返回。

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use crate::domain::{EventCategory, EventPhase, ExecutionEnv, TelemetryEvent};

use super::{EventSink, ExecutorError, InvocationInput, InvocationResult, Runner};

/// 注入的执行场景。
#[derive(Debug, Clone)]
pub enum MockScenario {
    /// 成功：返回固定输出与产物。
    Success {
        output: String,
        tokens: u64,
    },
    /// 失败：返回指定错误变体，供上层识别。
    Failure(ExecutorError),
    /// 取消：模拟被取消的执行（返回 Execution 错误描述取消）。
    Cancelled,
}

/// 确定性 mock 执行器：Runner 的测试替身实现。
#[derive(Clone)]
pub struct MockRunner {
    scenario: MockScenario,
    /// 事件序列：执行时按序经 sink 回流。
    events: Arc<Mutex<Vec<TelemetryEvent>>>,
    /// 已执行次数（确定性计数，供断言）。
    run_count: Arc<Mutex<usize>>,
}

impl MockRunner {
    /// 构造指定场景的 mock 执行器。
    pub fn new(scenario: MockScenario) -> Self {
        Self {
            scenario,
            events: Arc::new(Mutex::new(Self::default_events())),
            run_count: Arc::new(Mutex::new(0)),
        }
    }

    /// 覆盖默认事件序列。
    pub fn with_events(self, events: Vec<TelemetryEvent>) -> Self {
        *self.events.lock().unwrap() = events;
        self
    }

    /// 默认事件序列：start → progress → finish，归属由属性携带。
    fn default_events() -> Vec<TelemetryEvent> {
        vec![
            TelemetryEvent {
                category: EventCategory::Node,
                name: "mock.exec".to_string(),
                phase: EventPhase::Start,
                message: "mock 执行开始".to_string(),
                attributes: Default::default(),
            },
            TelemetryEvent {
                category: EventCategory::Node,
                name: "mock.exec".to_string(),
                phase: EventPhase::Progress,
                message: "mock 执行进行中".to_string(),
                attributes: Default::default(),
            },
            TelemetryEvent {
                category: EventCategory::Node,
                name: "mock.exec".to_string(),
                phase: EventPhase::Finish,
                message: "mock 执行完成".to_string(),
                attributes: Default::default(),
            },
        ]
    }

    /// 已执行的次数。
    pub fn run_count(&self) -> usize {
        *self.run_count.lock().unwrap()
    }
}

#[async_trait]
impl Runner for MockRunner {
    /// 确定性执行：按注入场景回流事件并返回结果或错误。
    ///
    /// 每条事件携带 run_id/node_id 关联标识属性；sink 同步调用不阻塞，
    /// 消费者缺失不影响结果返回。
    async fn run(
        &self,
        input: &InvocationInput,
        _role: &crate::domain::Role,
        _executor: &crate::domain::Executor,
        _env: Arc<dyn ExecutionEnv>,
        sink: EventSink<'_>,
    ) -> Result<InvocationResult, ExecutorError> {
        *self.run_count.lock().unwrap() += 1;
        for raw in self.events.lock().unwrap().clone() {
            let mut event = raw;
            event.attributes.insert(
                "runId".to_string(),
                serde_json::Value::String(input.run_id.clone()),
            );
            event.attributes.insert(
                "nodeId".to_string(),
                serde_json::Value::String(input.node_id.clone()),
            );
            sink(event);
        }
        match &self.scenario {
            MockScenario::Success { output, tokens } => Ok(InvocationResult {
                output: output.clone(),
                artifacts: Vec::new(),
                tokens: *tokens,
            }),
            MockScenario::Failure(err) => Err(err.clone()),
            MockScenario::Cancelled => Err(ExecutorError::Execution(
                "执行已被取消".to_string(),
            )),
        }
    }
}
