//! 测试替身 backend：记录调用并返回确定性数据。

use crate::backend::{
    ControlBackend, GatewayStatus, InternalBackend, InternalBackendError, OpsBackend, OpsOutcome,
    RunSummary, SandboxSummary,
};
use crate::error::BackendFailure;
use async_trait::async_trait;
use std::sync::Mutex;

/// 调用记录：方法名与参数快照，供测试断言。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub method: String,
    pub args: Vec<String>,
}

#[derive(Default)]
pub struct Recorder {
    pub calls: Mutex<Vec<Call>>,
}

impl Recorder {
    pub fn record(&self, method: &str, args: &[&str]) {
        self.calls.lock().unwrap().push(Call {
            method: method.into(),
            args: args.iter().map(|s| (*s).to_string()).collect(),
        });
    }

    pub fn snapshot(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    pub fn method_names(&self) -> Vec<String> {
        self.snapshot().into_iter().map(|c| c.method).collect()
    }
}

pub fn recording_ops_backend() -> RecordingOpsBackend {
    RecordingOpsBackend {
        recorder: Recorder::default(),
    }
}

pub fn recording_control_backend() -> RecordingControlBackend {
    RecordingControlBackend {
        recorder: Recorder::default(),
    }
}

/// 内部域替身：记录调用并持有归属产物，用于越权场景。
pub struct RecordingInternalBackend {
    pub recorder: Recorder,
    /// key: artifact_id，value: 归属 run_id
    pub artifacts: Vec<crate::backend::ArtifactView>,
}

pub fn recording_internal_backend(artifacts: Vec<crate::backend::ArtifactView>) -> RecordingInternalBackend {
    RecordingInternalBackend {
        recorder: Recorder::default(),
        artifacts,
    }
}

pub struct RecordingOpsBackend {
    pub recorder: Recorder,
}

pub struct RecordingControlBackend {
    pub recorder: Recorder,
}

#[async_trait]
impl OpsBackend for RecordingOpsBackend {
    async fn list_sandboxes(
        &self,
        run_id: Option<&str>,
    ) -> Result<Vec<SandboxSummary>, BackendFailure> {
        self.recorder
            .record("list_sandboxes", &[run_id.unwrap_or("")]);
        Ok(vec![SandboxSummary {
            sandbox_id: "sbx-1".into(),
            status: "running".into(),
            owner_run_id: run_id.unwrap_or("run-1").into(),
            endpoint: "10.0.0.1:22".into(),
        }])
    }

    async fn get_sandbox(&self, sandbox_id: &str) -> Result<SandboxSummary, BackendFailure> {
        self.recorder.record("get_sandbox", &[sandbox_id]);
        Ok(SandboxSummary {
            sandbox_id: sandbox_id.into(),
            status: "running".into(),
            owner_run_id: "run-1".into(),
            endpoint: "10.0.0.1:22".into(),
        })
    }

    async fn restart_sandbox(&self, sandbox_id: &str) -> Result<OpsOutcome, BackendFailure> {
        self.recorder.record("restart_sandbox", &[sandbox_id]);
        Ok(true)
    }

    async fn stop_sandbox(&self, sandbox_id: &str) -> Result<OpsOutcome, BackendFailure> {
        self.recorder.record("stop_sandbox", &[sandbox_id]);
        Ok(false)
    }

    async fn gateway_status(&self) -> Result<GatewayStatus, BackendFailure> {
        self.recorder.record("gateway_status", &[]);
        Ok(GatewayStatus {
            reachable: true,
            detail: "1 gateway online".into(),
        })
    }
}

#[async_trait]
impl ControlBackend for RecordingControlBackend {
    async fn get_run(&self, run_id: &str) -> Result<RunSummary, BackendFailure> {
        self.recorder.record("get_run", &[run_id]);
        Ok(RunSummary {
            run_id: run_id.into(),
            status: "running".into(),
            workflow_name: "demo".into(),
            node_count: 2,
        })
    }

    async fn list_runs(&self, status: Option<&str>) -> Result<Vec<RunSummary>, BackendFailure> {
        self.recorder.record("list_runs", &[status.unwrap_or("")]);
        Ok(vec![RunSummary {
            run_id: "run-1".into(),
            status: status.unwrap_or("running").into(),
            workflow_name: "demo".into(),
            node_count: 2,
        }])
    }

    async fn cancel_run(&self, run_id: &str) -> Result<OpsOutcome, BackendFailure> {
        self.recorder.record("cancel_run", &[run_id]);
        Ok(true)
    }

    async fn approve(
        &self,
        run_id: &str,
        node_id: &str,
        approved: bool,
    ) -> Result<OpsOutcome, BackendFailure> {
        self.recorder.record("approve", &[run_id, node_id, if approved { "true" } else { "false" }]);
        Ok(true)
    }
}

#[async_trait]
impl InternalBackend for RecordingInternalBackend {
    async fn get_run_status(&self, run_id: &str) -> Result<RunSummary, InternalBackendError> {
        self.recorder.record("get_run_status", &[run_id]);
        Ok(RunSummary {
            run_id: run_id.into(),
            status: "running".into(),
            workflow_name: "demo".into(),
            node_count: 2,
        })
    }

    async fn list_nodes(
        &self,
        run_id: &str,
    ) -> Result<Vec<crate::backend::NodeSnapshot>, InternalBackendError> {
        self.recorder.record("list_nodes", &[run_id]);
        Ok(vec![crate::backend::NodeSnapshot {
            node_id: "node-a".into(),
            status: "succeeded".into(),
            attempts: 1,
            artifacts: Vec::new(),
        }])
    }

    async fn get_artifact(
        &self,
        run_id: &str,
        artifact_id: &str,
    ) -> Result<crate::backend::ArtifactView, InternalBackendError> {
        self.recorder.record("get_artifact", &[run_id, artifact_id]);
        let found = self
            .artifacts
            .iter()
            .find(|a| a.artifact_id == artifact_id)
            .cloned();
        match found {
            Some(a) if a.owner_run_id == run_id => Ok(a),
            Some(a) => Err(InternalBackendError::CrossRun {
                resource: artifact_id.into(),
                owner_run: a.owner_run_id,
                context_run: run_id.into(),
            }),
            None => Err(InternalBackendError::NotFound {
                resource: artifact_id.into(),
            }),
        }
    }

    async fn list_artifacts(
        &self,
        run_id: &str,
    ) -> Result<Vec<crate::backend::ArtifactView>, InternalBackendError> {
        self.recorder.record("list_artifacts", &[run_id]);
        Ok(self
            .artifacts
            .iter()
            .filter(|a| a.owner_run_id == run_id)
            .cloned()
            .collect())
    }
}
