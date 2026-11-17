//! 流程执行引擎。
//!
//! 把一次运行从工作流定义实例化，按拓扑顺序调度节点执行，管理状态机流转、
//! 人工审批与打回、失败重试与崩溃恢复。持久化状态与事件后通知订阅方。
//! engine 属于 runs，通过本域 repository 与执行接口调用外部能力。

mod events;

use std::sync::Arc;

use crate::runs::RunRepository;
use tokio::sync::broadcast::Receiver;
use ursi_agent_runtime::Runner;
use ursi_domain::{Run, TelemetryEvent, WorkflowDefinition};

pub use events::EventBus;

/// 流程执行引擎：编排调度、状态机、人工审批、重试、恢复与事件广播。
#[allow(dead_code)]
pub struct Engine {
    store: Arc<dyn RunRepository>,
    runner: Arc<dyn Runner>,
    events: Arc<EventBus>,
}

impl Engine {
    /// 装配引擎所需依赖。
    pub fn new(
        store: Arc<dyn RunRepository>,
        runner: Arc<dyn Runner>,
        events: Arc<EventBus>,
    ) -> Self {
        Self {
            store,
            runner,
            events,
        }
    }

    /// 广播一条已持久化的运行事件，调用方负责先完成状态与事件提交。
    pub fn emit_event(&self, run_id: &str, event: TelemetryEvent) {
        self.events.emit(run_id, event);
    }

    /// 订阅运行事件流。
    pub fn subscribe_events(&self) -> Receiver<(String, TelemetryEvent)> {
        self.events.subscribe()
    }

    /// 从工作流定义创建一次运行，冻结工作流快照。
    pub async fn create_run(&self, wf: &WorkflowDefinition) -> Result<Run, EngineError> {
        let _ = wf;
        Err(EngineError::NotImplemented("create_run".to_string()))
    }

    /// 启动运行，按拓扑顺序调度节点执行。
    pub async fn start_run(&self, run_id: &str) -> Result<(), EngineError> {
        let _ = run_id;
        Err(EngineError::NotImplemented("start_run".to_string()))
    }

    /// 审批放行：让等待审批的节点继续，推进下游。
    pub async fn approve(&self, run_id: &str, node_id: &str) -> Result<(), EngineError> {
        let _ = (run_id, node_id);
        Err(EngineError::NotImplemented("approve".to_string()))
    }

    /// 审批打回：把运行重置到目标环节重新执行。
    pub async fn reject(
        &self,
        run_id: &str,
        node_id: &str,
        target_node_id: &str,
    ) -> Result<(), EngineError> {
        let _ = (run_id, node_id, target_node_id);
        Err(EngineError::NotImplemented("reject".to_string()))
    }
}

/// 引擎错误。
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("存储错误：{0}")]
    Store(#[from] crate::storage::StoreError),
    #[error("执行器错误：{0}")]
    Executor(#[from] ursi_agent_runtime::ExecutorError),
    #[error("功能尚未实现：{0}")]
    NotImplemented(String),
}
