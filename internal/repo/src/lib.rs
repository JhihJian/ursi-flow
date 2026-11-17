//! 持久化层：定义存储接口。
//!
//! 上层模块（engine、api）只依赖 `Store` 接口，不直接依赖具体存储实现。
//! SQLite 实现将在后续迭代中作为该接口的实现提供。

use async_trait::async_trait;
use ursi_domain::{Artifact, Role, Run, TelemetryEvent, WorkflowDefinition};

/// 存储接口：工作流、角色、运行、观测事件与产物的读写。
#[async_trait]
pub trait Store: Send + Sync {
    /// 保存工作流定义。
    async fn put_workflow(&self, wf: &WorkflowDefinition) -> Result<(), StoreError>;
    /// 读取工作流定义。
    async fn get_workflow(&self, id: &str) -> Result<Option<WorkflowDefinition>, StoreError>;

    /// 保存角色。
    async fn put_role(&self, role: &Role) -> Result<(), StoreError>;
    /// 读取角色。
    async fn get_role(&self, id: &str) -> Result<Option<Role>, StoreError>;

    /// 创建运行。
    async fn create_run(&self, run: &Run) -> Result<(), StoreError>;
    /// 读取运行。
    async fn get_run(&self, id: &str) -> Result<Option<Run>, StoreError>;
    /// 更新运行（带运行代数守卫，拒绝过期写入）。
    async fn update_run(&self, run: &Run) -> Result<(), StoreError>;

    /// 追加观测事件。
    async fn append_events(&self, run_id: &str, events: &[TelemetryEvent]) -> Result<(), StoreError>;
    /// 查询运行的观测事件。
    async fn list_events(&self, run_id: &str) -> Result<Vec<TelemetryEvent>, StoreError>;

    /// 查询运行产物。
    async fn list_artifacts(&self, run_id: &str) -> Result<Vec<Artifact>, StoreError>;
}

/// 存储错误。
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("资源不存在：{0}")]
    NotFound(String),
    #[error("状态提交被拒绝（代数过期）：{0}")]
    StaleGeneration(String),
    #[error("存储错误：{0}")]
    Storage(String),
}
