//! 运行域：快照、节点状态、审批、调度、恢复与运行事件。
//!
//! engine 是本域的执行实现。状态和事件通过同一提交接口持久化后再广播。
//! 当前保留执行入口骨架，快照和事务行为按 SPEC.md 实现与验收。

pub mod engine;

use async_trait::async_trait;
use ursi_domain::{Run, TelemetryEvent};

use crate::storage::StoreError;

/// 运行存储接口，仅暴露本域数据操作。
#[async_trait]
pub trait RunRepository: Send + Sync {
    async fn create_run(&self, run: &Run) -> Result<(), StoreError>;
    async fn get_run(&self, id: &str) -> Result<Option<Run>, StoreError>;

    /// 在同一事务内校验持有代数、更新运行并追加事件。
    /// 过期写入返回 StaleGeneration，失败时状态和事件均不落库。
    async fn commit_run(
        &self,
        run: &Run,
        expected_generation: u64,
        events: &[TelemetryEvent],
    ) -> Result<(), StoreError>;

    async fn list_events(&self, run_id: &str) -> Result<Vec<TelemetryEvent>, StoreError>;
}
