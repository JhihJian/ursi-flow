//! 后端契约：域操作不实现业务，经注入的窄接口访问平台状态。
//!
//! 三个契约分别由 server 装配时提供真实实现（如各业务域服务），
//! 本 crate 的域与 `McpServer` 只面向这些契约编程，测试注入替身。

use crate::error::BackendFailure;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// 沙箱与网关操作结果。`true` 表示后端执行了变更，`false` 表示后端
/// 判定无需变更（如幂等重入、已处于目标状态）。
pub type OpsOutcome = bool;

/// 运维域后端：沙箱与网关操作。
#[async_trait]
pub trait OpsBackend: Send + Sync {
    async fn list_sandboxes(
        &self,
        run_id: Option<&str>,
    ) -> Result<Vec<SandboxSummary>, BackendFailure>;
    async fn get_sandbox(&self, sandbox_id: &str) -> Result<SandboxSummary, BackendFailure>;
    async fn restart_sandbox(&self, sandbox_id: &str) -> Result<OpsOutcome, BackendFailure>;
    async fn stop_sandbox(&self, sandbox_id: &str) -> Result<OpsOutcome, BackendFailure>;
    async fn gateway_status(&self) -> Result<GatewayStatus, BackendFailure>;
}

/// 控制域后端：流程与运行操作。
#[async_trait]
pub trait ControlBackend: Send + Sync {
    async fn get_run(&self, run_id: &str) -> Result<RunSummary, BackendFailure>;
    async fn list_runs(&self, status: Option<&str>) -> Result<Vec<RunSummary>, BackendFailure>;
    async fn cancel_run(&self, run_id: &str) -> Result<OpsOutcome, BackendFailure>;
    async fn approve(
        &self,
        run_id: &str,
        node_id: &str,
        approved: bool,
    ) -> Result<OpsOutcome, BackendFailure>;
}

/// 内部工具域后端失败：类型化区分越权引用，供域映射为对应工具错误。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InternalBackendError {
    #[error("资源不存在：{resource}")]
    NotFound { resource: String },
    #[error("资源 {resource} 归属运行 {owner_run}，当前上下文运行 {context_run}")]
    CrossRun {
        resource: String,
        owner_run: String,
        context_run: String,
    },
    #[error("{message}")]
    Other { message: String },
}

/// 内部工具域后端：运行上下文内的产物与状态查询。
///
/// 实现方负责校验传入的 `run_id` 与资源实际归属是否一致，
/// 归属不符时返回 [`InternalBackendError::CrossRun`]。
#[async_trait]
pub trait InternalBackend: Send + Sync {
    async fn get_run_status(&self, run_id: &str) -> Result<RunSummary, InternalBackendError>;
    async fn list_nodes(&self, run_id: &str) -> Result<Vec<NodeSnapshot>, InternalBackendError>;
    async fn get_artifact(
        &self,
        run_id: &str,
        artifact_id: &str,
    ) -> Result<ArtifactView, InternalBackendError>;
    async fn list_artifacts(&self, run_id: &str) -> Result<Vec<ArtifactView>, InternalBackendError>;
}

/// 沙箱在工具输出中的只读视图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSummary {
    pub sandbox_id: String,
    pub status: String,
    /// 归属运行，空表示未绑定运行。
    pub owner_run_id: String,
    pub endpoint: String,
}

/// 网关运行状态视图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub reachable: bool,
    pub detail: String,
}

/// 节点执行状态与产物的平铺只读视图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSnapshot {
    pub node_id: String,
    pub status: String,
    pub attempts: u32,
    pub artifacts: Vec<ArtifactView>,
}

/// 产物在工具输出中的只读视图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactView {
    pub artifact_id: String,
    pub name: String,
    pub path: String,
    /// 归属运行，用于跨运行引用校验。
    pub owner_run_id: String,
    /// 归属节点，空表示无节点归属。
    pub owner_node_id: String,
}

/// 运行在工具输出中的只读摘要视图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    pub status: String,
    #[serde(default)]
    pub workflow_name: String,
    #[serde(default)]
    pub node_count: u32,
}
