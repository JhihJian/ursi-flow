//! The platform owns attempt identities and snapshots; MCP owns execution and its evidence.
mod binding;
mod client;
mod files;

use super::{Error, Store, agent_backends::Registry};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
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

impl Start {
    fn into_mcp_arguments(self, id: &str) -> Value {
        let mut args = json!({
            "attemptId": id,
            "workspaceRef": format!("workspace:{id}"),
            "artifactDirectoryRef": format!("artifacts:{id}"),
            "workInstruction": self.work_instruction.text,
        });
        if !self.run_config.is_empty() {
            args["runConfig"] = Value::Object(self.run_config);
        }
        args
    }
}

// Only omitted selectors opt into the legacy Flow route; an explicit null is invalid.
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
    flow: Option<binding::Backend>,
    registry: Registry,
    // Bound both concurrent subprocesses and lock storage. No database lock spans an RPC.
    locks: [Mutex<()>; 16],
}

pub(super) fn routes(store: Store, registry: Registry) -> Router {
    let service = Service {
        root: store.dir().join("executor-workspaces"),
        store,
        flow: binding::flow_from_env(),
        registry,
        locks: Default::default(),
    };
    Router::new()
        .route("/v2/executor-attempts/{id}", get(inspect).put(start))
        .route("/v2/executor-attempts/{id}/cancel", post(cancel))
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
    if body.work_patch_id.is_some() {
        return Err(Error::Invalid("平台不接受业务库的工作包引用".into()));
    }
    if serde_json::to_vec(&body).map_or(true, |b| b.len() > 512 * 1024) {
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
            if row["result"]["artifactDirectoryId"].is_string() {
                return Ok(row["result"].clone());
            }
        }
        let backend = if let Some(row) = &row {
            let backend = binding::backend_for_row(row, self.flow.as_ref(), &self.registry)?;
            if matches!(
                (&backend, &op),
                (binding::Backend::Agent(_), Operation::Start(..))
            ) {
                binding::verify_snapshot(
                    &self.root,
                    id,
                    row["configDigest"]
                        .as_str()
                        .ok_or_else(binding::unavailable)?,
                )?;
            }
            backend
        } else {
            let Operation::Start(body, entries, inputs_digest) = &op else {
                return Err(Error::NotFound("尝试不存在".into()));
            };
            let target = binding::target(body)?;
            let (backend, config) =
                binding::resolve(&self.store, &target, self.flow.as_ref(), &self.registry)?;
            let store = self.store.clone();
            let root = self.root.clone();
            let key = id.to_owned();
            let entries = entries.clone();
            let digest = tokio::task::spawn_blocking(move || {
                files::prepare_inputs(&store, &root, &key, None, &entries)?;
                config
                    .as_ref()
                    .map(|c| binding::create_snapshot(&root, &key, c))
                    .transpose()
            })
            .await
            .map_err(|_| Error::Internal("工作区准备中断".into()))??;
            let mut new = json!({
                "request": body,
                "backend": backend.mode(),
                "configDigest": digest,
                "inputsDigest": inputs_digest,
                "binding": backend.binding(),
                "result": {"attemptId":id,"status":"starting","artifactDirectoryRef":format!("artifacts:{id}")}
            });
            if let binding::Backend::Agent(entry) = &backend {
                new["backendId"] = json!(entry.id);
                new["result"]["backendId"] = json!(entry.id);
            }
            self.store.update(|db| {
                db["executorAttempts"][id] = new;
                Ok(())
            })?;
            backend
        };

        let (tool, args) = match op {
            Operation::Start(body, ..) => ("executor_start", body.into_mcp_arguments(id)),
            Operation::Inspect => ("executor_inspect", json!({"attemptId":id})),
            Operation::Cancel => ("executor_cancel", json!({"attemptId":id})),
        };
        let answer = client::call(&backend, &self.root, tool, args)
            .await
            .and_then(|v| validate(id, v));
        let answer = match answer {
            Ok(mut v) => {
                if let binding::Backend::Agent(entry) = &backend {
                    v["backendId"] = json!(entry.id);
                }
                v
            }
            Err(e) => {
                let last = self.store.update(|db| {
                    let result = &mut db["executorAttempts"][id]["result"];
                    result["status"] = json!("unverified");
                    Ok(result.clone())
                })?;
                // An existing Workbench attempt survives a missing or unreachable backend.
                if tool == "executor_inspect"
                    && matches!(e, Error::NotFound(_) | Error::Unavailable(_))
                {
                    return Ok(last);
                }
                return Err(e);
            }
        };
        let status = answer["status"].as_str().expect("validated");
        if matches!(status, "succeeded" | "failed" | "cancelled") {
            // Stage backend evidence without exposing success before the snapshot is committed.
            self.store.update(|db| {
                let r = &mut db["executorAttempts"][id];
                r["result"]["status"] = json!("unverified");
                r["result"]["backendRunRef"] = answer["backendRunRef"].clone();
                r["backendStatus"] = json!(status);
                Ok(())
            })?;
            let store = self.store.clone();
            let root = self.root.clone();
            let key = id.to_owned();
            let status = status.to_owned();
            tokio::task::spawn_blocking(move || files::publish(&store, &root, &key, &status))
                .await
                .map_err(|_| Error::Internal("制品收集中断".into()))?
        } else {
            self.store.update(|db| {
                db["executorAttempts"][id]["result"] = answer.clone();
                Ok(answer)
            })
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
        let args = request.request.into_mcp_arguments("attempt");
        assert_eq!(args["runConfig"]["nodeContract"], contract);
        assert_eq!(args["workInstruction"], "审核");
        assert!(args.get("inputs").is_none());
        wire["nodeContract"] = contract;
        assert!(serde_json::from_value::<Submitted>(wire.clone()).is_err());
        wire.as_object_mut().unwrap().remove("nodeContract");
        wire["runConfig"]["nodeContract"]["outcomes"] = json!([]);
        assert!(
            validate_node(&serde_json::from_value::<Submitted>(wire).unwrap().request).is_err()
        );
    }
}
fn validate(id: &str, v: Value) -> Result<Value, Error> {
    if v["attemptId"] != id
        || v["artifactDirectoryRef"] != format!("artifacts:{id}")
        || !matches!(
            v["status"].as_str(),
            Some("running" | "succeeded" | "failed" | "cancelled" | "unverified")
        )
    {
        return Err(binding::unavailable());
    }
    let mut result = json!({"attemptId":id,"artifactDirectoryRef":v["artifactDirectoryRef"],"status":v["status"]});
    if let Some(reference) = v.get("backendRunRef") {
        if !reference
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 256)
        {
            return Err(binding::unavailable());
        }
        result["backendRunRef"] = reference.clone();
    }
    Ok(result)
}
