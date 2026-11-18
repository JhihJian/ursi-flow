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

use crate::mcp::{
    ArtifactView, BackendFailure, ControlBackend, GatewayStatus, InternalBackend,
    InternalBackendError, NodeSnapshot, OpsBackend, OpsOutcome, RunSummary, SandboxSummary,
};
use async_trait::async_trait;

use crate::runs::{NodeArtifactRecord, RunRepository};

use crate::transport::{ApiError, RunDto, RunsApi, SandboxDto, SandboxesApi};

pub(crate) struct OpsBackendAdapter {
    sandboxes: Arc<dyn SandboxesApi>,
}

impl OpsBackendAdapter {
    pub(crate) fn new(sandboxes: Arc<dyn SandboxesApi>) -> Self {
        Self { sandboxes }
    }
}

fn sandbox_summary(sandbox: SandboxDto) -> SandboxSummary {
    SandboxSummary {
        // MCP 操作寻址运行关联，返回的 sandboxId 可以原样传给 get 和 stop。
        sandbox_id: sandbox.run_id.clone(),
        owner_run_id: sandbox.run_id,
        status: if sandbox.last_observed {
            format!("LastObserved({})", sandbox.status)
        } else {
            sandbox.status
        },
        endpoint: sandbox.endpoint.unwrap_or_default(),
    }
}

#[async_trait]
impl OpsBackend for OpsBackendAdapter {
    async fn list_sandboxes(
        &self,
        run_id: Option<&str>,
    ) -> Result<Vec<SandboxSummary>, BackendFailure> {
        let rows = self.sandboxes.list_sandboxes(run_id).await?;
        Ok(rows.into_iter().map(sandbox_summary).collect())
    }

    async fn get_sandbox(&self, sandbox_id: &str) -> Result<SandboxSummary, BackendFailure> {
        Ok(sandbox_summary(
            self.sandboxes.get_sandbox(sandbox_id).await?,
        ))
    }

    async fn restart_sandbox(&self, _sandbox_id: &str) -> Result<OpsOutcome, BackendFailure> {
        Err(ApiError::SandboxUnavailable {
            message: "未提供沙箱重启服务".into(),
        }
        .into())
    }

    async fn stop_sandbox(&self, sandbox_id: &str) -> Result<OpsOutcome, BackendFailure> {
        let sandbox = self.sandboxes.release(sandbox_id).await?;
        Ok(stop_outcome(&sandbox.status)?)
    }

    async fn gateway_status(&self) -> Result<GatewayStatus, BackendFailure> {
        Err(ApiError::SandboxUnavailable {
            message: "未提供 Gateway 健康检查服务".into(),
        }
        .into())
    }
}

fn stop_outcome(status: &str) -> Result<OpsOutcome, ApiError> {
    match status {
        "Released" => Ok(true),
        "ReleasePending" => Ok(false),
        _ => Err(ApiError::Internal),
    }
}

// ---------------------------------------------------------------------------
// Control 域：运行查询与审批
// ---------------------------------------------------------------------------

pub(crate) struct ControlBackendAdapter {
    runs: Arc<dyn RunsApi>,
}

impl ControlBackendAdapter {
    pub(crate) fn new(runs: Arc<dyn RunsApi>) -> Self {
        Self { runs }
    }
}

fn run_summary(run: RunDto) -> RunSummary {
    RunSummary {
        run_id: run.id,
        status: run.status,
        workflow_name: run.workflow.name,
        node_count: run.nodes.len() as u32,
    }
}

#[async_trait]
impl ControlBackend for ControlBackendAdapter {
    async fn get_run(&self, run_id: &str) -> Result<RunSummary, BackendFailure> {
        Ok(run_summary(self.runs.get_run(run_id).await?))
    }

    async fn list_runs(&self, status: Option<&str>) -> Result<Vec<RunSummary>, BackendFailure> {
        let runs = self.runs.list_runs().await?;
        Ok(runs
            .into_iter()
            .filter(|run| status.is_none_or(|s| run.status == s))
            .map(run_summary)
            .collect())
    }

    async fn cancel_run(&self, run_id: &str) -> Result<OpsOutcome, BackendFailure> {
        self.runs.cancel_run(run_id).await?;
        Ok(true)
    }

    async fn approve(
        &self,
        run_id: &str,
        node_id: &str,
        approved: bool,
    ) -> Result<OpsOutcome, BackendFailure> {
        if approved {
            self.runs.approve(run_id, node_id).await?;
        } else {
            // 打回目标经审批节点的 reject_to 声明解析；工具契约不携带
            // target 参数，未声明的打回按状态冲突报告。
            let target = self.reject_target(run_id, node_id).await?;
            self.runs.reject(run_id, node_id, &target).await?;
        }
        Ok(true)
    }
}

impl ControlBackendAdapter {
    /// 解析打回目标：审批节点的 `reject_to` 声明（domain 契约字段）。
    /// 无声明的审批节点不支持经工具打回。
    async fn reject_target(&self, run_id: &str, node_id: &str) -> Result<String, ApiError> {
        let run = self.runs.get_run(run_id).await?;
        let node = run
            .workflow
            .nodes
            .iter()
            .find(|n| n.id == node_id)
            .ok_or_else(|| ApiError::not_found(format!("运行 {run_id} 节点 {node_id}")))?;
        node.reject_to.clone().ok_or_else(|| {
            ApiError::conflict(format!("审批节点 {node_id} 未声明打回目标（reject_to）"))
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

    async fn list_artifacts(
        &self,
        run_id: &str,
    ) -> Result<Vec<ArtifactView>, InternalBackendError> {
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
    async fn require_run(
        &self,
        run_id: &str,
    ) -> Result<flow_core::domain::Run, InternalBackendError> {
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
    InternalBackendError::Other {
        message: e.to_string(),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::{Domain, McpServer};
    use crate::transport::mcp::map_tool_error;
    use crate::transport::stubs::{FakeRuns, FakeSandboxes, sample_workflow};
    use serde_json::json;

    #[test]
    fn stop_only_confirms_a_released_sandbox() {
        assert_eq!(stop_outcome("Released"), Ok(true));
        assert_eq!(stop_outcome("ReleasePending"), Ok(false));
        assert!(stop_outcome("Unknown").is_err());
    }

    #[tokio::test]
    async fn stop_errors_keep_the_http_status_and_code() {
        let sandboxes = Arc::new(FakeSandboxes::default());
        let server = McpServer::with_domain(Domain::Ops(Arc::new(OpsBackendAdapter::new(
            sandboxes.clone(),
        ))))
        .unwrap();
        for expected in [
            ApiError::SandboxUnavailable {
                message: "未配置 Gateway".into(),
            },
            ApiError::GatewayUnauthorized,
            ApiError::GatewayProtocol,
            ApiError::conflict("释放冲突"),
            ApiError::not_found("运行"),
            ApiError::forbidden("无权操作"),
            ApiError::bad_request("参数无效"),
            ApiError::Internal,
        ] {
            sandboxes.faults.set("release", expected.clone());
            let error = server
                .invoke("ops_stop_sandbox", None, json!({"sandbox_id":"run"}))
                .await
                .unwrap_err();
            let actual = map_tool_error(error);
            assert_eq!(
                (actual.status(), actual.code()),
                (expected.status(), expected.code())
            );
        }
    }

    #[tokio::test]
    async fn control_actions_use_the_shared_runs_service() {
        let runs = Arc::new(FakeRuns::default());
        let mut workflow = sample_workflow("wf");
        workflow.nodes[0].reject_to = Some("earlier".into());
        let seed = RunDto {
            id: "r".into(),
            status: "waiting".into(),
            workflow,
            nodes: Vec::new(),
            generation: 1,
        };
        runs.seed(seed.clone());
        let control = ControlBackendAdapter::new(runs.clone());
        control.approve("r", "n1", false).await.unwrap();
        let calls = runs.recorder.snapshot();
        assert_eq!(calls[1].method, "reject");
        assert_eq!(calls[1].args, ["r", "n1", "earlier"]);
        runs.seed(seed);
        control.approve("r", "n1", true).await.unwrap();
        assert_eq!(runs.get_run("r").await.unwrap().status, "running");
        control.cancel_run("r").await.unwrap();
        assert_eq!(runs.get_run("r").await.unwrap().status, "cancelled");
        assert!(control.list_runs(Some("running")).await.unwrap().is_empty());
        assert_eq!(
            control.list_runs(Some("cancelled")).await.unwrap()[0].run_id,
            "r"
        );
    }
}
