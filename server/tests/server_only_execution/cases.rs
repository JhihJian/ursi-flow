//! 运行：cargo test -p ursi-server --lib server_only_execution
use super::AppConfig;
use super::assembly::{assemble, assemble_with_test_execution};
use async_trait::async_trait;
use flow_core::agent_runtime::{MockRunner, MockScenario};
use flow_core::domain::{EnvError, ExecutionEnv};
use flow_core::runs::engine::{ScriptExecutionError, ScriptInvocation};
use flow_core::runs::{ResourceReleaseError, ResourceReleaser, ScriptWorkspaces};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct Workspace {
    files: Mutex<HashMap<String, Vec<u8>>>,
    read_fault: Arc<AtomicBool>,
}

#[async_trait]
impl ExecutionEnv for Workspace {
    async fn exec(&self, script: &str) -> Result<(i32, String), EnvError> {
        let code = match script {
            "emit" => 0,
            "emit-and-fail" => 7,
            _ => return Err(EnvError::Exec("unexpected test script".into())),
        };
        self.write_file("report", b"archived report").await?;
        self.write_file("log", b"diagnostic bytes").await?;
        Ok((code, "test output".into()))
    }

    async fn write_file(&self, path: &str, bytes: &[u8]) -> Result<(), EnvError> {
        self.files.lock().unwrap().insert(path.into(), bytes.into());
        Ok(())
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, EnvError> {
        if path == "log" && self.read_fault.load(Ordering::SeqCst) {
            return Err(EnvError::Other("injected read failure".into()));
        }
        self.files
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .ok_or_else(|| EnvError::FileNotFound(path.into()))
    }
}

#[derive(Default)]
struct Workspaces {
    runs: Mutex<HashMap<String, Vec<Arc<Workspace>>>>,
    releases: AtomicUsize,
    read_fault: Arc<AtomicBool>,
}

impl ScriptWorkspaces for Workspaces {
    fn open(&self, call: &ScriptInvocation) -> Result<Arc<dyn ExecutionEnv>, ScriptExecutionError> {
        assert_eq!(call.language, "test");
        let env = Arc::new(Workspace {
            read_fault: self.read_fault.clone(),
            ..Default::default()
        });
        self.runs
            .lock()
            .unwrap()
            .entry(call.run_id.clone())
            .or_default()
            .push(env.clone());
        Ok(env)
    }
}

#[async_trait]
impl ResourceReleaser for Workspaces {
    async fn release(&self, run_id: &str) -> Result<(), ResourceReleaseError> {
        if let Some(envs) = self.runs.lock().unwrap().remove(run_id) {
            for env in envs {
                env.files.lock().unwrap().clear();
            }
            self.releases.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

async fn post(client: &Client, url: String, body: Value, expected: StatusCode) -> Value {
    let response = client.post(url).json(&body).send().await.unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    assert_eq!(status, expected, "{body}");
    serde_json::from_str(&body).unwrap()
}

async fn get(client: &Client, url: String) -> Value {
    client
        .get(url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn create_run(client: &Client, base: &str, script: &str) -> String {
    post(client, format!("{base}/workflows"), json!({"id":"wf-script", "name":"script", "nodes":[{
        "id":"script", "name":"script", "type":"script", "script":script, "scriptLanguage":"test",
        "artifactOutputs":[{"name":"report","path":"report","required":true}, {"name":"log","path":"log","required":true}, {"name":"optional","path":"missing","required":false}]
    }], "edges":[]}), StatusCode::CREATED).await;
    let run = post(
        client,
        format!("{base}/runs"),
        json!({"workflowId":"wf-script"}),
        StatusCode::CREATED,
    )
    .await;
    run["id"].as_str().unwrap().into()
}

fn config(dir: &tempfile::TempDir) -> AppConfig {
    let mut config = AppConfig::for_test(dir.path().into());
    config.listen_addr = ([0, 0, 0, 0], 0).into();
    config.cleanup_retry_interval = Duration::from_millis(100);
    config
}

async fn exercise(script: &str, read_fault: bool) {
    let dir = tempfile::tempdir().unwrap();
    let workspaces = Arc::new(Workspaces::default());
    workspaces.read_fault.store(read_fault, Ordering::SeqCst);
    let app = assemble_with_test_execution(
        config(&dir),
        Arc::new(MockRunner::new(MockScenario::Success {
            output: "unused".into(),
            tokens: 0,
        })),
        workspaces.clone(),
    )
    .await
    .unwrap();
    let client = Client::builder().no_proxy().build().unwrap();
    let base = format!("http://127.0.0.1:{}/api/v1", app.addr().port());
    let id = create_run(&client, &base, script).await;
    let finished = post(
        &client,
        format!("{base}/runs/{id}/start"),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    let node = &finished["nodes"][0];
    assert_eq!(finished["status"], node["status"]);
    assert_eq!(node["attempt"], 1);
    if read_fault {
        assert_eq!(node["status"], "failed");
        assert!(node["error"].as_str().unwrap().contains("归档失败"));
        assert_eq!(workspaces.releases.load(Ordering::SeqCst), 0);
        assert_eq!(
            workspaces.runs.lock().unwrap()[&id][0]
                .files
                .lock()
                .unwrap()["log"],
            b"diagnostic bytes"
        );
        let partial = get(&client, format!("{base}/artifacts?runId={id}")).await;
        assert_eq!(partial["items"].as_array().unwrap().len(), 1);
        assert_eq!(partial["items"][0]["name"], "report");
        workspaces.read_fault.store(false, Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(5), async {
            while workspaces.releases.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("后台重试归档后释放");
    } else if script == "emit-and-fail" {
        assert_eq!(node["status"], "failed");
        assert!(node["error"].as_str().unwrap().contains("退出码 7"));
    } else {
        assert_eq!(node["status"], "succeeded");
        assert_eq!(node["output"], "test output");
    }
    assert_eq!(workspaces.releases.load(Ordering::SeqCst), 1);
    assert!(!workspaces.runs.lock().unwrap().contains_key(&id));
    let listed = get(&client, format!("{base}/artifacts?runId={id}")).await;
    let items = listed["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    for (name, bytes) in [("report", "archived report"), ("log", "diagnostic bytes")] {
        let item = items.iter().find(|item| item["name"] == name).unwrap();
        let object = get(
            &client,
            format!("{base}/artifacts/{}", item["id"].as_str().unwrap()),
        )
        .await;
        assert_eq!(object["runId"], id);
        assert_eq!(object["nodeId"], "script");
        assert_eq!(object["attempt"], 1);
        assert_eq!(object["content"], bytes);
    }
    app.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn success_archives_before_release() {
    exercise("emit", false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_script_preserves_outputs() {
    exercise("emit-and-fail", false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partial_archive_retains_workspace_until_retry() {
    exercise("emit", true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn production_rejects_the_same_script() {
    let dir = tempfile::tempdir().unwrap();
    let app = assemble(config(&dir)).await.unwrap();
    let base = format!("http://127.0.0.1:{}/api/v1", app.addr().port());
    let client = Client::builder().no_proxy().build().unwrap();
    let id = create_run(&client, &base, "emit").await;
    post(
        &client,
        format!("{base}/runs/{id}/start"),
        Value::Null,
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await;
    let run = get(&client, format!("{base}/runs/{id}")).await;
    assert_eq!(run["nodes"][0]["attempt"], 0);
    assert_eq!(
        get(&client, format!("{base}/artifacts?runId={id}")).await["items"],
        json!([])
    );
    app.shutdown().await;
}
