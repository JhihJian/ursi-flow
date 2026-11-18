//! 生产装配只执行实时就绪、具有独立运行身份的 Runtime 文本任务。
use async_trait::async_trait;
use flow_core::agent_runtime::{
    EventSink, ExecutorError, InvocationInput, InvocationResult, Runner,
};
use flow_core::domain::{ExecutionEnv, Executor, NodeType, Role, WorkflowDefinition};
#[cfg(feature = "sandbox-access")]
use flow_core::sandboxes::PlatformView;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::watch;

use super::sandbox::SandboxesApiAdapter;
use crate::transport::ApiError;

pub(super) struct ProductionRunner {
    pub sandboxes: Arc<SandboxesApiAdapter>,
    #[cfg_attr(not(feature = "sandbox-access"), allow(dead_code))]
    pub bindings: Option<PathBuf>,
}

fn unavailable(message: &str) -> ApiError {
    ApiError::SandboxUnavailable {
        message: message.to_owned(),
    }
}

impl ProductionRunner {
    #[cfg(feature = "sandbox-access")]
    async fn binding(
        &self,
        view: &PlatformView,
    ) -> Result<sandbox_access::runtime_acp::Binding, ApiError> {
        let dir = self
            .bindings
            .as_deref()
            .ok_or_else(|| unavailable("未配置 ACP 运行身份"))?;
        sandbox_access::runtime_acp::Binding::resolve(dir, view)
            .await
            .map_err(|_| unavailable("ACP 运行身份与就绪端点不匹配"))
    }

    pub(super) async fn admit(
        &self,
        run_id: &str,
        workflow: &WorkflowDefinition,
    ) -> Result<(), ApiError> {
        if workflow
            .nodes
            .iter()
            .all(|n| n.node_type == NodeType::Approval)
        {
            return Ok(());
        }
        let _view = self.sandboxes.ready_view(run_id).await?;
        if workflow
            .nodes
            .iter()
            .any(|n| n.node_type == NodeType::Script || !n.artifact_outputs.is_empty())
        {
            return Err(unavailable("未配置沙箱脚本执行或文件回收通道"));
        }
        #[cfg(feature = "sandbox-access")]
        {
            self.binding(&_view).await.map(|_| ())
        }
        #[cfg(not(feature = "sandbox-access"))]
        {
            Err(unavailable("未启用 sandbox-access"))
        }
    }
}

#[async_trait]
impl Runner for ProductionRunner {
    async fn run(
        &self,
        input: &InvocationInput,
        role: &Role,
        executor: &Executor,
        env: Arc<dyn ExecutionEnv>,
        sink: EventSink<'_>,
    ) -> Result<InvocationResult, ExecutorError> {
        let (_tx, rx) = watch::channel(false);
        self.run_cancellable(input, role, executor, env, sink, rx)
            .await
    }

    async fn run_cancellable(
        &self,
        input: &InvocationInput,
        role: &Role,
        _executor: &Executor,
        _env: Arc<dyn ExecutionEnv>,
        _sink: EventSink<'_>,
        cancel: watch::Receiver<bool>,
    ) -> Result<InvocationResult, ExecutorError> {
        #[cfg(feature = "sandbox-access")]
        {
            if _executor.kind.as_str() != "pi" {
                return Err(ExecutorError::Launch("ACP 执行需要显式 Pi 角色".into()));
            }
            let view = self
                .sandboxes
                .ready_view(&input.run_id)
                .await
                .map_err(|e| ExecutorError::Launch(e.message()))?;
            let binding = self
                .binding(&view)
                .await
                .map_err(|e| ExecutorError::Launch(e.message()))?;
            let prompt = [&role.prompt, &input.prompt, &input.artifact_context]
                .into_iter()
                .map(String::as_str)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            let output = binding.execute(role, &prompt, cancel).await?;
            Ok(InvocationResult {
                output,
                ..Default::default()
            })
        }
        #[cfg(not(feature = "sandbox-access"))]
        {
            let _ = (input, role, cancel);
            Err(ExecutorError::Launch("未启用 sandbox-access".into()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn workflow_with(node_types: &[&str]) -> WorkflowDefinition {
        let nodes: Vec<_> = node_types
            .iter()
            .enumerate()
            .map(|(i, ty)| json!({"id": i.to_string(), "name": ty, "type": ty}))
            .collect();
        serde_json::from_value(json!({"id":"w","name":"w","nodes":nodes})).unwrap()
    }

    fn offline() -> ProductionRunner {
        let config = super::super::AppConfig::for_test(Default::default());
        let store = flow_core::sandboxes::SandboxStore::open(":memory:").unwrap();
        let sandboxes = SandboxesApiAdapter::new(store, &config).unwrap();
        ProductionRunner {
            sandboxes: Arc::new(sandboxes),
            bindings: None,
        }
    }

    #[tokio::test]
    async fn approval_only_needs_no_sandbox() {
        offline()
            .admit("r", &workflow_with(&["approval"]))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rejects_remote_work_anywhere_in_the_snapshot() {
        for ty in ["agent", "script"] {
            let err = offline()
                .admit("r", &workflow_with(&["approval", ty]))
                .await
                .unwrap_err();
            assert_eq!(err.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(err.code(), "sandbox_unavailable");
        }
    }
}
