//! 运行域：快照、节点状态、审批、调度、租约、恢复与运行事件。
//!
//! engine 是本域的执行实现：按拓扑顺序调度节点，状态与事件经同一提交入口
//! （[`RunRepository::commit_run`]，带持有代数 CAS 校验）持久化成功后再广播。
//! 存储层 [`SqliteRunStore`] 直连 SQLite 自管 `runs_domain` 迁移，事件序号在
//! 提交时确定；租约表与运行表同库，[`Clock`] 可注入以模拟租约到期
//! （SPEC「状态提交、租约与取消」）。
//!
//! 第二阶段收尾已落实：
//! - 角色冻结配置：[`FrozenRoles`] / [`RunSnapshot::roles`] 在执行 agent 节点
//!   时解析回 [`ursi_domain::Role`] 交给 Runner（提示词、模型、skills、MCP、
//!   执行器标识全部来自冻结快照）；创建时校验 agent 引用的角色在冻结集合
//!   中且 JSON 合法，缺失即创建失败（SPEC「运行创建与配置冻结」）；
//! - 产物归属：节点成功后按声明写入 [`NodeArtifactRecord`]（归运行、节点、
//!   代数、attempt），必需产物契约检查先于归属落库（缺失即节点失败，下游
//!   不执行）；下游只接收当前有效轮次（最新 attempt）的上游输出；
//! - 迟到防护：同一持有代数内旧 attempt 的提交被 attempt 回退防护拒绝，
//!   执行期间返工时旧 attempt 结果按迟到丢弃；
//! - 资源收尾：终态后 [`ResourceReleaser`] 释放，清理状态持久化可查询重试；
//! - 沙箱脚本执行：[`engine::ScriptExecutor`] 注入实现，真实沙箱经 channel
//!   接入后替换测试替身（后续阶段）。

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
use ursi_domain::{Run, RunStatus, TelemetryEvent};

use crate::storage::StoreError;

/// 冻结的角色配置集合：role_id → 角色配置 JSON。
///
/// 冻结值为 [`ursi_domain::Role`] 的 JSON 序列化（camelCase：提示词、模型、
/// skills、MCP 配置、执行器标识）。创建运行时经各域一致读取后传入，执行时
/// engine 解析回 `Role` 交给 Runner（SPEC「运行创建与配置冻结」）。与 roles
/// 域 `export_freezable` 的完整冻结形态（技能文件包、结构化 MCP 配置、凭据
/// 引用）是配置域联合验收点，本域契约以 Role 字段为最小集合。
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

/// 节点产物归属记录：节点声明的产物 + 执行身份
/// （DESIGN「状态、事件与产物」：artifacts 按运行、节点、代数和执行尝试
/// 保存产物；attempt 是 runs 分配的单调执行编号）。
///
/// 与 artifacts 域联调点：内容寻址标识与实际内容存取由 artifacts 域承载，
/// 本域保存「哪个轮次声明产生了哪些产物」的归属事实；联调时本域归属表
/// 作为 runs 侧的轮次有效性判据（下游只取最新 attempt 的产物）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeArtifactRecord {
    pub run_id: String,
    pub node_id: String,
    /// 记录归属时的运行持有代数。
    pub generation: u64,
    /// 该产物对应的节点累计执行编号。
    pub attempt: u32,
    pub name: String,
    pub path: String,
    pub media_type: Option<String>,
    pub required: bool,
}

/// 资源清理状态（SPEC「查询、事件与资源收尾」：运行终止后请求释放资源，
/// 记录独立的清理结果）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupState {
    /// 已请求释放、尚未确认。
    Pending,
    /// 释放完成。
    Done,
    /// 释放失败（可查询错误并重试；运行执行结果不受影响）。
    Failed,
}

/// 一次资源清理的持久化结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupStatus {
    pub run_id: String,
    pub state: CleanupState,
    /// 失败原因（仅 Failed 时存在）。
    pub error: Option<String>,
}

/// 资源释放接口：运行终止后由 engine 调用，释放沙箱、会话等关联资源。
///
/// 真实实现经 sandboxes/Gateway 接入；失败可查询并重试（DESIGN「资源与会
/// 话」：释放请求失败或结果未知时保留待核实状态）。
#[async_trait]
pub trait ResourceReleaser: Send + Sync {
    /// 释放运行关联资源。失败返回错误，运行执行结果不受影响。
    async fn release(&self, run_id: &str) -> Result<(), ResourceReleaseError>;
}

/// 资源释放错误。
#[derive(Debug, thiserror::Error)]
pub enum ResourceReleaseError {
    #[error("资源释放失败：{0}")]
    Failed(String),
}

impl CleanupState {
    pub fn as_str(self) -> &'static str {
        match self {
            CleanupState::Pending => "pending",
            CleanupState::Done => "done",
            CleanupState::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(CleanupState::Pending),
            "done" => Some(CleanupState::Done),
            "failed" => Some(CleanupState::Failed),
            _ => None,
        }
    }
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

    /// 读取冻结快照（工作流 + 角色配置）；不存在返回 `None`。
    async fn get_snapshot(&self, id: &str) -> Result<Option<RunSnapshot>, StoreError>;

    /// 记录节点产物归属：按节点声明逐项落库，归属当前执行身份
    /// （run_id, node_id, generation, attempt）。同一身份重复记录幂等
    /// （主键去重）。
    async fn record_node_artifacts(
        &self,
        run_id: &str,
        node_id: &str,
        generation: u64,
        attempt: u32,
        declared: &[ursi_domain::ArtifactContract],
    ) -> Result<(), StoreError>;

    /// 列出运行全部产物归属（含历史轮次，attempt 升序）；未知运行返回空。
    async fn list_node_artifacts(&self, run_id: &str)
        -> Result<Vec<NodeArtifactRecord>, StoreError>;

    /// 记录资源清理状态（pending / done / failed），UPSERT 语义。
    async fn set_cleanup_status(
        &self,
        run_id: &str,
        state: CleanupState,
        error: Option<&str>,
    ) -> Result<(), StoreError>;

    /// 查询资源清理状态；未记录返回 `None`。
    async fn cleanup_status(&self, run_id: &str) -> Result<Option<CleanupStatus>, StoreError>;

    /// 按序号升序返回运行全部事件；未知运行返回空列表。
    async fn list_events(&self, run_id: &str) -> Result<Vec<RunEventRecord>, StoreError>;

    /// 返回序号大于 `after_seq` 的事件（升序），供游标补读
    /// （transport SSE 重放与断线补读联合验收使用）。
    async fn list_events_since(
        &self,
        run_id: &str,
        after_seq: i64,
    ) -> Result<Vec<RunEventRecord>, StoreError>;

    /// 按状态过滤列出运行标识与状态，`statuses` 为空时返回全部运行。
    /// 按创建时间降序，供列表查询与恢复扫描使用。
    async fn list_runs(&self, statuses: &[RunStatus]) -> Result<Vec<RunSummary>, StoreError>;
}

/// 运行列表项：标识与状态摘要（不含完整快照）。
#[derive(Debug, Clone)]
pub struct RunSummary {
    pub id: String,
    pub status: RunStatus,
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
