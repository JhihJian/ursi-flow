//! 异步 Flow 用例。目录、修订与运行状态由 Runtime 持有。
mod runtime;

use runtime::Call;
pub use runtime::FlowClient;
use serde_json::Value;
use std::{io, path::PathBuf};
use uuid::Uuid;

#[derive(Clone)]
pub struct FlowService {
    client: FlowClient,
    workspace: PathBuf,
}

impl FlowService {
    pub fn new(client: FlowClient, workspace: PathBuf) -> Self {
        Self { client, workspace }
    }

    pub async fn flows(&self) -> io::Result<Value> {
        self.client.call(Call::Flows).await
    }
    pub async fn flow(&self, id: String) -> io::Result<Value> {
        self.client.call(Call::Flow(id)).await
    }
    pub async fn create(&self, id: String, files: Value) -> io::Result<Value> {
        self.client.call(Call::Create(id, files)).await
    }
    pub async fn validate(&self, id: String, files: Value) -> io::Result<Value> {
        self.client.call(Call::Validate(id, files)).await
    }
    pub async fn update(
        &self,
        id: String,
        files: Value,
        expected_revision: Option<String>,
    ) -> io::Result<Value> {
        self.client
            .call(Call::Update {
                id,
                files,
                expected_revision,
            })
            .await
    }
    pub async fn delete(&self, id: String) -> io::Result<Value> {
        self.client.call(Call::Delete(id)).await
    }
    pub async fn start(
        &self,
        flow: String,
        run_id: Option<String>,
        workspace: &str,
        variables: Value,
        executor_ref: Option<Value>,
    ) -> io::Result<Value> {
        if workspace != "default" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "workspace 必须为 default",
            ));
        }
        self.client
            .call(Call::Start {
                id: run_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                flow,
                cwd: self.workspace.clone(),
                variables,
                executor_ref,
            })
            .await
    }
    pub async fn runs(&self) -> io::Result<Value> {
        self.client.call(Call::Runs).await
    }
    pub async fn run(&self, id: String) -> io::Result<Value> {
        self.client.call(Call::Run(id)).await
    }
    pub async fn history(&self, id: String) -> io::Result<Value> {
        self.client.call(Call::History(id)).await
    }
    pub async fn stop(&self, id: String) -> io::Result<Value> {
        self.client.call(Call::Stop(id)).await
    }
    pub async fn config(&self) -> io::Result<Value> {
        self.client.call(Call::Config).await
    }
    pub async fn configure(&self, patch: Value) -> io::Result<Value> {
        self.client.call(Call::Configure(patch)).await
    }
}

#[cfg(test)]
mod tests;
