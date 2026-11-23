//! The platform owns durable attempts and a dedicated ACP worker per execution.
mod binding;
mod client;
mod files;
mod journal;
mod worker;
pub(crate) use worker::work;

use super::{Error, Store, agent_backends::Registry};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    routing::{get, post},
};
pub(in crate::work) use client::probe_agent;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Instruction {
    text: String,
    encoding: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecutorRef {
    id: String,
    revision: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    executor_ref: Option<ExecutorRef>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    preview_definition: Option<Value>,
    work_instruction: Instruction,
    // Only embedded mode accepts this reference. The standalone access boundary rejects it.
    work_patch_id: Option<String>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    run_config: serde_json::Map<String, Value>,
}

// Selectors must be omitted or present with a valid value.
fn present<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    de: D,
) -> Result<Option<T>, D::Error> {
    Option::deserialize(de)?
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("目标不能为 null"))
}

struct Service {
    store: Store,
    root: PathBuf,
    registry: Registry,
    // Serialize operations for an attempt. Worker capacity is bounded separately.
    locks: [Mutex<()>; 16],
}

pub(super) fn routes(store: Store, registry: Registry) -> Router {
    let service = Service {
        root: store.dir().join("executor-workspaces"),
        store,
        registry,
        locks: Default::default(),
    };
    Router::new()
        .route("/v2/executor-attempts/{id}", get(inspect).put(start))
        .route("/v2/executor-attempts/{id}/cancel", post(cancel))
        .route("/v2/executor-attempts/{id}/events", get(events))
        .layer(DefaultBodyLimit::max(128 * 1024 * 1024))
        .with_state(Arc::new(service))
}
type Reply = Result<Json<Value>, Error>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Submitted {
    #[serde(default, deserialize_with = "present")]
    inputs: Option<Vec<files::Input>>,
    #[serde(flatten)]
    request: Start,
}

fn validate_node(body: &Start) -> Result<(), Error> {
    let Some(contract) = body.run_config.get("nodeContract") else {
        return Ok(());
    };
    let invalid =
        || Error::Invalid("节点请求需要固定执行器版本和有效的 runConfig.nodeContract".into());
    if body.executor_ref.is_none()
        || body.preview_definition.is_some()
        || !contract.as_object().is_some_and(|c| c.len() == 2)
    {
        return Err(invalid());
    }
    for key in ["outcomes", "variables"] {
        let list = contract[key].as_array().ok_or_else(invalid)?;
        if list.len() > 256 || key == "outcomes" && list.is_empty() {
            return Err(invalid());
        }
        let mut seen = std::collections::HashSet::new();
        for item in list {
            let name = item
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(invalid)?;
            if !seen.insert(name) {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

async fn start(
    State(s): State<Arc<Service>>,
    Path(id): Path<String>,
    submission: Result<Json<Submitted>, axum::extract::rejection::JsonRejection>,
) -> Reply {
    // Serde rejection details may include submitted instruction or material content.
    let Json(Submitted {
        request: body,
        mut inputs,
    }) = submission.map_err(|_| Error::Invalid("尝试请求无效或超过大小上限".into()))?;
    validate_node(&body)?;
    if body.run_config.keys().any(|key| key != "nodeContract") {
        return Err(Error::Invalid("不支持该执行配置".into()));
    }
    if body.work_patch_id.is_some() {
        return Err(Error::Invalid("平台不接受业务库的工作包引用".into()));
    }
    if serde_json::to_vec(&body).map_or(true, |b| b.len() > 512 * 1024)
        || body
            .run_config
            .get("nodeContract")
            .is_some_and(|v| serde_json::to_vec(v).map_or(true, |b| b.len() > 128 * 1024))
    {
        return Err(Error::Invalid("指令和执行配置超过大小上限".into()));
    }
    if body.work_instruction.encoding != "utf-8"
        || body.work_instruction.text.trim().is_empty()
        || body.work_instruction.text.len() > 256 * 1024
    {
        return Err(Error::Invalid("需要非空 UTF-8 指令，最多 256 KiB".into()));
    }
    let (entries, digest) = tokio::task::spawn_blocking(move || {
        let digest = inputs.as_deref_mut().map(files::input_digest).transpose()?;
        Ok::<_, Error>((Arc::from(inputs.unwrap_or_default()), digest))
    })
    .await
    .map_err(|_| Error::Internal("输入检查中断".into()))??;
    run(s, id, Operation::Start(body, entries, digest)).await
}
async fn inspect(State(s): State<Arc<Service>>, Path(id): Path<String>) -> Reply {
    run(s, id, Operation::Inspect).await
}
async fn cancel(State(s): State<Arc<Service>>, Path(id): Path<String>) -> Reply {
    run(s, id, Operation::Cancel).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    #[serde(default)]
    after: u64,
}
async fn events(
    State(s): State<Arc<Service>>,
    Path(id): Path<String>,
    Query(cursor): Query<Cursor>,
) -> Reply {
    let uuid = Uuid::parse_str(&id)
        .ok()
        .filter(|u| u.to_string() == id)
        .ok_or_else(|| Error::Invalid("需要小写标准 UUID".into()))?;
    // Do not mistake a reservation still in its launch handshake for worker loss.
    let _guard = s.locks[usize::from(uuid.as_bytes()[15]) % s.locks.len()]
        .lock()
        .await;
    let acp = s.store.read(|db| {
        db["executorAttempts"]
            .get(&id)
            .map(|row| row["backend"] == "acp")
            .ok_or_else(|| Error::NotFound("尝试不存在".into()))
    })?;
    if !acp {
        return Ok(Json(json!({"events":[],"nextCursor":cursor.after})));
    }
    let dir = s.root.join(id);
    tokio::task::spawn_blocking(move || journal::page(&dir, cursor.after))
        .await
        .map_err(|_| binding::unavailable())?
        .map(Json)
}

enum Operation {
    Start(Start, Arc<[files::Input]>, Option<String>),
    Inspect,
    Cancel,
}
async fn run(s: Arc<Service>, id: String, op: Operation) -> Reply {
    let uuid = Uuid::parse_str(&id)
        .ok()
        .filter(|u| u.to_string() == id)
        .ok_or_else(|| Error::Invalid("需要小写标准 UUID".into()))?;
    // Detach from the HTTP connection: losing its response must not interrupt reservation or publication.
    tokio::spawn(async move {
        let _guard = s.locks[usize::from(uuid.as_bytes()[15]) % s.locks.len()]
            .lock()
            .await;
        s.drive(&id, op).await.map(Json)
    })
    .await
    .map_err(|_| Error::Internal("执行尝试任务中断".into()))?
}
impl Service {
    async fn drive(&self, id: &str, op: Operation) -> Result<Value, Error> {
        let row = self
            .store
            .read(|db| Ok(db["executorAttempts"].get(id).cloned()))?;
        if let (Some(row), Operation::Start(body, _, digest)) = (&row, &op) {
            if row["request"] != json!(body) || row["inputsDigest"].as_str() != digest.as_deref() {
                return Err(Error::Conflict("同一尝试 ID 已绑定其他输入".into()));
            }
        }

        if let Some(row) = &row {
            if matches!(
                row["result"]["status"].as_str(),
                Some("succeeded" | "failed" | "cancelled")
            ) {
                return Ok(row["result"].clone());
            }
        }
        let row = if let Some(row) = row {
            row
        } else {
            let Operation::Start(body, entries, inputs_digest) = &op else {
                return Err(Error::NotFound("尝试不存在".into()));
            };
            let (backend, config) =
                binding::resolve(&self.store, &binding::target(body)?, &self.registry)?;
            let store = self.store.clone();
            let root = self.root.clone();
            let key = id.to_owned();
            let entries = entries.clone();
            let instruction = body.work_instruction.text.clone();
            let node = body.run_config.get("nodeContract").cloned();
            let digest = tokio::task::spawn_blocking(move || {
                files::prepare_inputs(&store, &root, &key, None, &entries)?;
                let digest = binding::create_snapshot(&root, &key, &config)?;
                let dir = root.join(&key);
                let mut job = json!({"cwd":dir.join("workspace"),"configDigest":digest});
                if let Some(node) = node {
                    job["nodeContract"] = node;
                }
                journal::write(&dir.join("acp-job.json"), &job)
                    .map_err(|_| binding::unavailable())?;
                journal::write(
                    &dir.join("acp-request.json"),
                    &json!({"instruction":instruction,"configDigest":digest}),
                )
                .map_err(|_| binding::unavailable())?;
                Ok::<_, Error>(digest)
            })
            .await
            .map_err(|_| Error::Internal("工作区准备中断".into()))??;
            let mut new = json!({
                "request":body,"backend":"acp","backendId":backend.id,"configDigest":digest,
                "inputsDigest":inputs_digest,"binding":super::catalog::entry_binding(&backend),
                "result":{"attemptId":id,"status":"running","backendId":backend.id,"artifactDirectoryRef":format!("artifacts:{id}")}
            });
            self.store.update(|db| {
                db["executorAttempts"][id] = new.clone();
                Ok(())
            })?;
            if worker::launch(&self.root, id, &backend.bin, &backend.policy)
                .await
                .is_ok()
            {
                return Ok(new["result"].clone());
            }
            new["result"]["status"] = json!("unverified");
            return Ok(new["result"].clone());
        };
        let mut result = row["result"].clone();
        if row["backend"] != "acp" {
            // In-flight legacy attempts are never redirected to the new backend.
            result["status"] = json!("unverified");
            return Ok(result);
        }
        let dir = self.root.join(id);
        if matches!(op, Operation::Cancel) {
            journal::write(&dir.join("acp-cancel.json"), &json!(true))
                .map_err(|_| binding::unavailable())?;
        }
        if journal::running(&dir)? {
            result["status"] = json!("running");
            return Ok(result);
        }
        let observed = journal::read(&dir.join("acp-result.json"), 1024)
            .map_err(|_| binding::unavailable())?;
        let status = observed
            .as_ref()
            .filter(|v| v["writersStopped"] == true)
            .and_then(|v| v["status"].as_str())
            .unwrap_or("unverified");
        match status {
            "succeeded" | "failed" | "cancelled" => {
                let store = self.store.clone();
                let root = self.root.clone();
                let key = id.to_owned();
                let status = status.to_owned();
                tokio::task::spawn_blocking(move || {
                    // A worker may have crashed after rename and before syncing the directory.
                    std::fs::File::open(root.join(&key))
                        .and_then(|dir| dir.sync_all())
                        .map_err(|_| binding::unavailable())?;
                    match files::publish(&store, &root, &key, &status) {
                        Err(Error::Invalid(_)) => store.update(|db| {
                            let result = &mut db["executorAttempts"][&key]["result"];
                            result["status"] = json!(if status == "cancelled" {
                                "cancelled"
                            } else {
                                "failed"
                            });
                            result["artifactError"] = json!("invalid_artifacts");
                            Ok(result.clone())
                        }),
                        other => other,
                    }
                })
                .await
                .map_err(|_| Error::Internal("制品收集中断".into()))?
            }
            _ => {
                result["status"] = json!("unverified");
                Ok(result)
            }
        }
    }
}
#[cfg(test)]
mod submitted_tests {
    use super::*;
    #[test]
    fn node_fields_stay_under_run_config_and_never_contain_materials() {
        let contract = json!({"outcomes":["通过"],"variables":["result"]});
        let mut wire = json!({"executorRef":{"id":"reviewer","revision":7},"workInstruction":{"encoding":"utf-8","text":"审核"},"runConfig":{"nodeContract":contract},"inputs":[{"kind":"file","path":"material","contentBase64":"AA=="}]});
        let request: Submitted = serde_json::from_value(wire.clone()).unwrap();
        validate_node(&request.request).unwrap();
        assert_eq!(request.request.run_config["nodeContract"], contract);
        assert_eq!(request.request.work_instruction.text, "审核");
        assert!(
            serde_json::to_value(&request.request)
                .unwrap()
                .get("inputs")
                .is_none()
        );
        wire["nodeContract"] = contract;
        assert!(serde_json::from_value::<Submitted>(wire.clone()).is_err());
        wire.as_object_mut().unwrap().remove("nodeContract");
        wire["runConfig"]["nodeContract"]["outcomes"] = json!([]);
        assert!(
            validate_node(&serde_json::from_value::<Submitted>(wire).unwrap().request).is_err()
        );
    }
}
