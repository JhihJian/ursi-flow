//! 运行域：快照、节点状态、审批、调度、租约、恢复与运行事件。
//!
//! engine 是本域的执行实现：按拓扑顺序调度节点，状态与事件经同一提交入口
//! （[`RunRepository::commit_run`]，带持有代数 CAS 校验）持久化成功后再广播。
//! 存储层 [`SqliteRunStore`] 直连 SQLite 自管 `runs_domain` 迁移，事件序号在
//! 提交时确定；租约表与运行表同库，[`Clock`] 可注入以模拟租约到期
//! （SPEC「状态提交、租约与取消」）。
//!
//! 第二阶段接口点：
//! - 角色冻结配置：[`FrozenRoles`] / [`RunSnapshot::roles`]，engine 目前传空
//!   映射占位，角色能力、执行器与沙箱配置的冻结在此接入；
//! - 沙箱脚本执行：[`engine::ScriptExecutor`] 注入实现，真实沙箱经 channel
//!   接入后替换测试替身；
//! - 产物归属 attempt 映射：节点累计执行编号（attempts 单调递增）已持久化，
//!   artifacts 按「运行、节点、代数、attempt」归属的联合在 artifacts 域完成
//!   （DESIGN「状态、事件与产物」）。

pub mod clock;
pub mod engine;
mod store;

#[cfg(test)]
mod store_tests;
#[cfg(test)]
pub(crate) mod testing;

pub use clock::{Clock, SystemClock};
pub use store::{RUNS_MIGRATIONS, SqliteRunStore};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use ursi_domain::{Run, TelemetryEvent};

use crate::storage::StoreError;

/// 冻结的角色配置集合：role_id → 角色配置 JSON。
///
/// 本阶段创建运行时传空映射占位；角色能力、执行器与沙箱配置的冻结在
/// 下一阶段接入（SPEC「运行创建与配置冻结」）。
pub type FrozenRoles = serde_json::Map<String, serde_json::Value>;

/// 运行快照：创建时冻结的工作流与角色配置，后续编辑不影响在途运行。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSnapshot {
    pub workflow: ursi_domain::WorkflowDefinition,
    /// 冻结的角色配置（role_id → 配置）。本阶段为空映射。
    #[serde(default)]
    pub roles: FrozenRoles,
}

/// 已持久化的运行事件：在 [`TelemetryEvent`] 外封装运行标识与单调序号。
/// 序号在提交时确定，提交、查询和广播使用同一记录身份（SPEC「查询、事件
/// 与资源收尾」）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunEventRecord {
    pub run_id: String,
    pub seq: i64,
    pub event: TelemetryEvent,
}

/// 租约状态快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaseState {
    pub holder: String,
    /// 当前持有代数（与运行代数同源，acquire/接管时递增）。
    pub generation: u64,
    /// 到期时间（毫秒，注入时钟的时基）。
    pub expires_at_ms: i64,
    /// 相对当前注入时钟是否已到期。
    pub expired: bool,
}

/// 租约操作错误。「持有冲突」「已到期」与存储故障可区分。
#[derive(Debug, thiserror::Error)]
pub enum LeaseError {
    #[error("运行 {0} 不存在")]
    NotFound(String),
    #[error("运行 {run_id} 租约被 {holder} 持有")]
    Held { run_id: String, holder: String },
    #[error("运行 {run_id} 租约已到期，原持有者 {holder}")]
    Expired { run_id: String, holder: String },
    #[error("运行 {0} 没有租约")]
    NoLease(String),
    #[error("存储错误：{0}")]
    Storage(String),
}

impl From<rusqlite::Error> for LeaseError {
    fn from(err: rusqlite::Error) -> Self {
        LeaseError::Storage(err.to_string())
    }
}

impl From<StoreError> for LeaseError {
    fn from(err: StoreError) -> Self {
        match err {
            StoreError::NotFound(id) => LeaseError::NotFound(id),
            StoreError::Storage(msg) => LeaseError::Storage(msg),
            other => LeaseError::Storage(other.to_string()),
        }
    }
}

/// 运行存储接口，仅暴露本域数据操作。
///
/// rusqlite 为同步接口，实现内的数据库操作都是短事务；异步方法直接同步
/// 完成，不做 block_in_place 包装（单元规模数据下阻塞可忽略）。
#[async_trait]
pub trait RunRepository: Send + Sync {
    /// 保存新运行及冻结快照（工作流 + 角色配置）。运行初始 generation
    /// 由调用方给定（约定 1），节点状态一并落库。
    async fn create_run(&self, run: &Run, frozen_roles: &FrozenRoles) -> Result<(), StoreError>;

    /// 读取运行（含冻结快照与节点状态）；不存在返回 `None`。
    async fn get_run(&self, id: &str) -> Result<Option<Run>, StoreError>;

    /// 在同一事务内校验持有代数、更新运行与节点状态并追加事件。
    /// - 代数校验为 CAS：`UPDATE ... WHERE generation = expected`，影响 0 行
    ///   返回 [`StoreError::StaleGeneration`]，当前结果不被覆盖；
    /// - 快照不随提交改写（创建时已冻结）；
    /// - 事件序号在提交时确定：seq = 该运行当前 max(seq) + 1 起连续递增；
    /// - 任一步失败整体回滚，状态和事件均不落库。
    async fn commit_run(
        &self,
        run: &Run,
        expected_generation: u64,
        events: &[TelemetryEvent],
    ) -> Result<(), StoreError>;

    /// 按序号升序返回运行全部事件；未知运行返回空列表。
    async fn list_events(&self, run_id: &str) -> Result<Vec<RunEventRecord>, StoreError>;

    /// 返回序号大于 `after_seq` 的事件（升序），供游标补读
    /// （transport SSE 重放与断线补读联合验收使用）。
    async fn list_events_since(
        &self,
        run_id: &str,
        after_seq: i64,
    ) -> Result<Vec<RunEventRecord>, StoreError>;
}

/// 租约表接口：运行级持有租约，与运行同库同事务约束。
///
/// 代数与租约的关系：acquire（首次获取或到期接管）使运行 generation 递增
/// 并返回新代数；持有者以该代数调用 [`RunRepository::commit_run`]。租约
/// 到期后其他持有者接管，旧持有者的提交因代数过期被拒绝。
#[async_trait]
pub trait LeaseTable: Send + Sync {
    /// 获取或接管运行租约。空闲（无租约）或已到期时成功，持有代数 +1 并
    /// 返回新代数；持有期内被他人持有则返回 [`LeaseError::Held`]。
    async fn acquire_lease(
        &self,
        run_id: &str,
        holder: &str,
        ttl_ms: u64,
    ) -> Result<u64, LeaseError>;

    /// 续约：仅当前持有者在到期前可续，延长到期时间为 now + ttl。
    async fn renew_lease(&self, run_id: &str, holder: &str, ttl_ms: u64)
        -> Result<(), LeaseError>;

    /// 查询租约状态；无租约返回 `None`。
    async fn check_lease(&self, run_id: &str) -> Result<Option<LeaseState>, LeaseError>;
}
