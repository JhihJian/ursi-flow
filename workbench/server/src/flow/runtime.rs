use serde_json::Value;
use std::{io, path::PathBuf, sync::Arc};
use tokio::sync::Semaphore;
use ursi_flow_client::FlowClient as SdkClient;

const MAX_CLIENT_CALLS: usize = 8;

#[derive(Clone)]
pub struct FlowClient {
    sdk: SdkClient,
    slots: Arc<Semaphore>,
}

pub(super) enum Call {
    Flows,
    Flow(String),
    Create(String, Value),
    Validate(String, Value),
    Update {
        id: String,
        files: Value,
        expected_revision: Option<String>,
    },
    Delete(String),
    Start {
        id: String,
        flow: String,
        cwd: PathBuf,
        variables: Value,
        executor_ref: Option<Value>,
    },
    Runs,
    Run(String),
    History(String),
    Stop(String),
    Config,
    Configure(Value),
}

impl FlowClient {
    pub fn new(sdk: SdkClient) -> Self {
        Self {
            sdk,
            slots: Arc::new(Semaphore::new(MAX_CLIENT_CALLS)),
        }
    }

    pub(super) async fn call(&self, call: Call) -> io::Result<Value> {
        let permit = self
            .slots
            .clone()
            .acquire_owned()
            .await
            .map_err(io::Error::other)?;
        let sdk = self.sdk.clone();
        tokio::task::spawn_blocking(move || {
            // HTTP 任务被取消时，已提交的同步调用仍占用名额直至结束。
            let _permit = permit;
            match call {
                Call::Flows => sdk.flows(),
                Call::Flow(id) => sdk.flow(&id),
                Call::Create(id, files) => sdk.create(&id, files),
                Call::Validate(id, files) => sdk.validate(&id, files),
                Call::Update {
                    id,
                    files,
                    expected_revision,
                } => sdk.update_if(&id, files, expected_revision.as_deref()),
                Call::Delete(id) => sdk.delete(&id),
                Call::Start {
                    id,
                    flow,
                    cwd,
                    variables,
                    executor_ref,
                } => sdk.start_with_executor(&id, &flow, &cwd, variables, None, executor_ref),
                Call::Runs => sdk.runs(),
                Call::Run(id) => sdk.run(&id),
                Call::History(id) => sdk.history(&id),
                Call::Stop(id) => sdk.stop(&id),
                Call::Config => sdk.config(),
                Call::Configure(patch) => sdk.configure(patch),
            }
        })
        .await
        .map_err(io::Error::other)?
    }
}
