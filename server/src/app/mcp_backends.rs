//! MCP 三域后端的装配适配器：把 mcp-server crate 的后端契约接到本服务
//! 的域服务上（mcp-server SPEC：「三个契约分别由 server 装配时提供真实
//! 实现」）。
//!
//! 身份与越权：
//! - Ops / Control 域按身份隔离边界约定只供控制面使用，工具层不做
//!   运行归属校验；
//! - Internal 域的运行身份来自可信调用上下文（x-run-id），后端把传入
//!   run_id 与资源实际归属比对，不一致返回
//!   [`InternalBackendError::CrossRun`]（工具层映射为 403 语义）。
//!
//! 错误文本只含资源标识与状态名，无凭据字段。

use std::sync::Arc;

use async_trait::async_trait;
use ursi_mcp_server::{
    ArtifactView, BackendFailure, ControlBackend, GatewayStatus, InternalBackend,
    InternalBackendError, NodeSnapshot, OpsBackend, OpsOutcome, RunSummary, SandboxSummary,
};

use crate::runs::{NodeArtifactRecord, RunRepository};

pub(crate) struct OpsBackendAdapter {
    sandbox_store: Arc<crate::sandboxes::SandboxStore>,
}

impl OpsBackendAdapter {
    pub(crate) fn new(sandbox_store: Arc<crate::sandboxes::SandboxStore>) -> Self {
        Self { sandbox_store }
    }
}

#[async_trait]
impl OpsBackend for OpsBackendAdapter {
    async fn list_sandboxes(
        &self,
        _run_id: Option<&str>,
    ) -> Result<Vec<SandboxSummary>, BackendFailure> {
        // sandboxes 域按 run 维度管理关联，无全表/按状态列举入口；
        // 不伪造清单，明确失败（与 transport 列举缺口同一事实来源约束）。
        Err(BackendFailure {
            message: "沙箱列举入口尚未提供（域接口按运行维度管理关联）".to_string(),
        })
    }

    async fn get_sandbox(&self, sandbox_id: &str) -> Result<SandboxSummary, BackendFailure> {
        // 沙箱关联按 run 维度管理；MCP 调用方持有的是运行标识时可直接
        // 查询，持有平台沙箱标识的反查入口（按 sandbox_id 索引）域接口
        // 未提供，明确失败（不伪造查询结果）。
        let view = self
            .sandbox_store
            .platform_view(sandbox_id)
            .map_err(|e| BackendFailure { message: e.to_string() })?
            .ok_or_else(|| BackendFailure {
                message: format!("沙箱 {sandbox_id} 不存在"),
            })?;
        Ok(SandboxSummary {
            sandbox_id: view.sandbox_id.unwrap_or_default(),
            status: view.state.as_str().to_string(),
            owner_run_id: view.run_id,
            endpoint: view
                .endpoints
                .first()
                .map(|e| e.address.clone())
                .unwrap_or_default(),
        })
    }

    async fn restart_sandbox(&self, _sandbox_id: &str) -> Result<OpsOutcome, BackendFailure> {
        Err(BackendFailure {
            message: "沙箱重启操作未接入 Gateway 控制面（装配占位）".to_string(),
        })
    }

    async fn stop_sandbox(&self, sandbox_id: &str) -> Result<OpsOutcome, BackendFailure> {
        // 释放即本地关联收敛为 Released（控制面接入前的明确边界，见
        // app mod.rs 交付说明）。
        self.sandbox_store
            .record_released(sandbox_id)
            .map_err(|e| BackendFailure { message: e.to_string() })?;
        Ok(true)
    }

    async fn gateway_status(&self) -> Result<GatewayStatus, BackendFailure> {
        Ok(GatewayStatus {
            reachable: false,
            detail: "Gateway 控制面尚未接入（装配占位）".to_string(),
        })
    }
}

// ---------------------------------------------------------------------------
// Control 域：运行查询与审批
// ---------------------------------------------------------------------------

pub(crate) struct ControlBackendAdapter {
    engine: Arc<crate::runs::engine::Engine>,
    runs_store: Arc<crate::runs::SqliteRunStore>,
}

impl ControlBackendAdapter {
    pub(crate) fn new(
        engine: Arc<crate::runs::engine::Engine>,
        runs_store: Arc<crate::runs::SqliteRunStore>,
    ) -> Self {
        Self { engine, runs_store }
    }

    async fn summary(&self, run_id: &str) -> Result<RunSummary, BackendFailure> {
        let run = self
            .runs_store
            .get_run(run_id)
            .await
            .map_err(|e| BackendFailure { message: e.to_string() })?
            .ok_or_else(|| BackendFailure {
                message: format!("运行 {run_id} 不存在"),
            })?;
        Ok(RunSummary {
            run_id: run.id,
            status: run.status.as_str().to_string(),
            workflow_name: run.workflow.name,
            node_count: run.nodes.len() as u32,
        })
    }
}

#[async_trait]
impl ControlBackend for ControlBackendAdapter {
    async fn get_run(&self, run_id: &str) -> Result<RunSummary, BackendFailure> {
        self.summary(run_id).await
    }

    async fn list_runs(&self, _status: Option<&str>) -> Result<Vec<RunSummary>, BackendFailure> {
        Err(BackendFailure {
            message: "运行列举入口尚未提供（RunRepository 无全表查询）".to_string(),
        })
    }

    async fn cancel_run(&self, run_id: &str) -> Result<OpsOutcome, BackendFailure> {
        self.engine
            .cancel(run_id)
            .await
            .map_err(|e| BackendFailure { message: e.to_string() })?;
        Ok(true)
    }

    async fn approve(
        &self,
        run_id: &str,
        node_id: &str,
        approved: bool,
    ) -> Result<OpsOutcome, BackendFailure> {
        let result = if approved {
            self.engine.approve(run_id, node_id).await
        } else {
            // 打回目标经审批节点的 reject_to 声明解析；工具契约不携带
            // target 参数，未声明的打回按状态冲突报告。
            let target = self.reject_target(run_id, node_id).await?;
            self.engine.reject(run_id, node_id, &target).await
        };
        result.map_err(|e| BackendFailure { message: e.to_string() })?;
        Ok(true)
    }
}

impl ControlBackendAdapter {
    /// 解析打回目标：审批节点的 `reject_to` 声明（domain 契约字段）。
    /// 无声明的审批节点不支持经工具打回。
    async fn reject_target(&self, run_id: &str, node_id: &str) -> Result<String, BackendFailure> {
        let run = self
            .runs_store
            .get_run(run_id)
            .await
            .map_err(|e| BackendFailure { message: e.to_string() })?
            .ok_or_else(|| BackendFailure {
                message: format!("运行 {run_id} 不存在"),
            })?;
        let node = run
            .workflow
            .nodes
            .iter()
            .find(|n| n.id == node_id)
            .ok_or_else(|| BackendFailure {
                message: format!("运行 {run_id} 节点 {node_id} 不存在"),
            })?;
        node.reject_to.clone().ok_or_else(|| BackendFailure {
            message: format!("审批节点 {node_id} 未声明打回目标（reject_to）"),
        })
    }
}

// ---------------------------------------------------------------------------
// Internal 域：上下文内的状态与产物查询
// ---------------------------------------------------------------------------

pub(crate) struct InternalBackendAdapter {
    runs_store: Arc<crate::runs::SqliteRunStore>,
}

impl InternalBackendAdapter {
    pub(crate) fn new(runs_store: Arc<crate::runs::SqliteRunStore>) -> Self {
        Self { runs_store }
    }
}

#[async_trait]
impl InternalBackend for InternalBackendAdapter {
    async fn get_run_status(&self, run_id: &str) -> Result<RunSummary, InternalBackendError> {
        let run = self.require_run(run_id).await?;
        Ok(RunSummary {
            run_id: run.id,
            status: run.status.as_str().to_string(),
            workflow_name: run.workflow.name,
            node_count: run.nodes.len() as u32,
        })
    }

    async fn list_nodes(&self, run_id: &str) -> Result<Vec<NodeSnapshot>, InternalBackendError> {
        let run = self.require_run(run_id).await?;
        let artifacts = self
            .runs_store
            .list_node_artifacts(&run.id)
            .await
            .map_err(other)?;
        Ok(run
            .nodes
            .iter()
            .map(|node| NodeSnapshot {
                node_id: node.node_id.clone(),
                status: node.status.as_str().to_string(),
                attempts: node.attempts,
                artifacts: artifacts
                    .iter()
                    .filter(|record| record.node_id == node.node_id)
                    .map(|record| artifact_view(record))
                    .collect(),
            })
            .collect())
    }

    async fn get_artifact(
        &self,
        run_id: &str,
        artifact_id: &str,
    ) -> Result<ArtifactView, InternalBackendError> {
        let run = self.require_run(run_id).await?;
        let artifacts = self
            .runs_store
            .list_node_artifacts(&run.id)
            .await
            .map_err(other)?;
        // 产物稳定标识由 app 投影（见 adapters::ArtifactsApiAdapter）：
        // art-{run_id}-{node_id}-{attempt}-{name}；在本运行的归属记录
        // 内按 ID 比对，跨运行引用天然不匹配（NotFound）。
        let record = artifacts
            .iter()
            .find(|record| artifact_record_id(run_id, record) == artifact_id)
            .ok_or_else(|| InternalBackendError::NotFound {
                resource: artifact_id.to_string(),
            })?;
        Ok(artifact_view(record))
    }

    async fn list_artifacts(&self, run_id: &str) -> Result<Vec<ArtifactView>, InternalBackendError> {
        let run = self.require_run(run_id).await?;
        let artifacts = self
            .runs_store
            .list_node_artifacts(&run.id)
            .await
            .map_err(other)?;
        Ok(artifacts.iter().map(artifact_view).collect())
    }
}

impl InternalBackendAdapter {
    /// 读取运行并校验上下文归属（Internal 域越权防线）。
    async fn require_run(&self, run_id: &str) -> Result<ursi_domain::Run, InternalBackendError> {
        self.runs_store
            .get_run(run_id)
            .await
            .map_err(|e| InternalBackendError::Other {
                message: e.to_string(),
            })?
            .ok_or_else(|| InternalBackendError::NotFound {
                resource: run_id.to_string(),
            })
    }
}

fn other(e: crate::storage::StoreError) -> InternalBackendError {
    InternalBackendError::Other { message: e.to_string() }
}

fn artifact_record_id(run_id: &str, record: &NodeArtifactRecord) -> String {
    format!(
        "art-{}-{}-{}-{}",
        run_id, record.node_id, record.attempt, record.name
    )
}

fn artifact_view(record: &NodeArtifactRecord) -> ArtifactView {
    ArtifactView {
        artifact_id: artifact_record_id(&record.run_id, record),
        name: record.name.clone(),
        path: record.path.clone(),
        owner_run_id: record.run_id.clone(),
        owner_node_id: record.node_id.clone(),
    }
}
