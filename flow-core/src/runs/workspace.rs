//! 在轮次隔离的工作区执行脚本，按声明归档产物，再释放运行资源。
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::engine::{
    ScriptExecutionError, ScriptExecutionResult, ScriptExecutor, ScriptInvocation,
};
use super::{ResourceReleaseError, ResourceReleaser};
use crate::artifacts::{ArtifactStore, PutArtifactRequest};
use crate::domain::{Artifact, EnvError, ExecutionEnv};
use async_trait::async_trait;

/// 提供脚本执行环境，并在运行收尾时幂等释放该运行的工作区。
pub trait ScriptWorkspaces: ResourceReleaser {
    /// 按轮次隔离命令和文件访问。已结束轮次的文件须保持可读，直至释放。
    fn open(
        &self,
        invocation: &ScriptInvocation,
    ) -> Result<Arc<dyn ExecutionEnv>, ScriptExecutionError>;
}

#[derive(Clone)]
struct Attempt {
    invocation: ScriptInvocation,
    env: Arc<dyn ExecutionEnv>,
}

/// 同一实例作为引擎的脚本执行器和资源释放器，供终态收尾重试归档。
pub struct WorkspaceExecution {
    workspaces: Arc<dyn ScriptWorkspaces>,
    store: Arc<ArtifactStore>,
    // 工作区句柄只保存在本实例内。重启后仅有持久化的清理状态，不能据此
    // 重建待归档轮次；接入跨进程恢复前，必须能核实并重新打开原工作区。
    pending: Mutex<HashMap<String, Vec<Attempt>>>,
}

impl WorkspaceExecution {
    pub fn new(workspaces: Arc<dyn ScriptWorkspaces>, store: Arc<ArtifactStore>) -> Self {
        Self {
            workspaces,
            store,
            pending: Mutex::default(),
        }
    }

    async fn archive(&self, attempt: &Attempt) -> Result<Vec<Artifact>, String> {
        let call = &attempt.invocation;
        let mut archived = Vec::new();
        for contract in &call.artifact_outputs {
            let bytes = match attempt.env.read_file(&contract.path).await {
                Ok(bytes) => bytes,
                Err(EnvError::FileNotFound(_)) if !contract.required => continue,
                Err(e) => return Err(format!("读取 {} 失败：{e}", contract.path)),
            };
            let request = PutArtifactRequest {
                run_id: call.run_id.clone(),
                node_id: call.node_id.clone(),
                generation: call.generation,
                attempt: call.attempt.into(),
                name: contract.name.clone(),
                path: contract.path.clone(),
                required: contract.required,
                media_type: contract.media_type.clone(),
                bytes,
                idempotency_key: serde_json::json!([
                    call.run_id,
                    call.node_id,
                    call.generation,
                    call.attempt,
                    contract.name,
                    contract.path
                ])
                .to_string(),
            };
            let store = self.store.clone();
            let record = tokio::task::spawn_blocking(move || store.put(request))
                .await
                .map_err(|e| format!("归档任务 {} 中断：{e}", contract.path))?
                .map_err(|e| format!("提交 {} 失败：{e}", contract.path))?;
            archived.push(record.to_domain());
        }
        Ok(archived)
    }
}

#[async_trait]
impl ScriptExecutor for WorkspaceExecution {
    async fn exec(
        &self,
        invocation: ScriptInvocation,
    ) -> Result<ScriptExecutionResult, ScriptExecutionError> {
        let env = self.workspaces.open(&invocation)?;
        let attempt = Attempt { invocation, env };
        let result = attempt.env.exec(&attempt.invocation.script).await;
        // 退出码不能证明没写过文件。即使脚本失败，也先回收已声明的输出。
        let artifacts = match self.archive(&attempt).await {
            Ok(archived) => archived,
            Err(e) => {
                self.pending
                    .lock()
                    .unwrap()
                    .entry(attempt.invocation.run_id.clone())
                    .or_default()
                    .push(attempt);
                return Err(ScriptExecutionError::Failed(format!(
                    "归档失败，保留工作区：{e}"
                )));
            }
        };
        match result {
            Ok((0, output)) => Ok(ScriptExecutionResult { output, artifacts }),
            Ok((code, _)) => Err(ScriptExecutionError::Failed(format!("退出码 {code}"))),
            Err(e) => Err(ScriptExecutionError::Failed(e.to_string())),
        }
    }
}

#[async_trait]
impl ResourceReleaser for WorkspaceExecution {
    async fn release(&self, run_id: &str) -> Result<(), ResourceReleaseError> {
        let pending = self
            .pending
            .lock()
            .unwrap()
            .get(run_id)
            .cloned()
            .unwrap_or_default();
        for attempt in &pending {
            // 后台重试与即时收尾走同一入口。部分提交按 attempt 幂等复用。
            self.archive(attempt)
                .await
                .map_err(ResourceReleaseError::Failed)?;
        }
        // 归档已确认。若释放结果未知，下次只重试释放，不再读取可能已销毁的文件。
        self.pending.lock().unwrap().remove(run_id);
        self.workspaces.release(run_id).await
    }
}
