//! 流程定义管理：图结构、节点配置与角色引用校验。
//!
//! 流程管理拥有可编辑定义，执行状态和冻结快照归 runs。
//! 当前保留定义读写骨架，完整管理与验收契约见 SPEC.md。

use async_trait::async_trait;
use ursi_domain::WorkflowDefinition;

use crate::storage::StoreError;

/// 流程定义存储接口，仅暴露本域数据操作。
#[async_trait]
pub trait WorkflowRepository: Send + Sync {
    async fn put_workflow(&self, workflow: &WorkflowDefinition) -> Result<(), StoreError>;
    async fn get_workflow(&self, id: &str) -> Result<Option<WorkflowDefinition>, StoreError>;
}
