//! Workbench owns attempt identities and snapshots; MCP owns execution and its evidence.
mod binding;
mod client;
mod files;

use super::{Error, Store};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    routing::{get, post},
};
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
    work_patch_id: Option<String>,
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
    pi: Option<binding::Backend>,
    // Bound both concurrent subprocesses and lock storage. No database lock spans an RPC.
    locks: [Mutex<()>; 16],
}

pub(super) fn routes(store: Store) -> Router {
    let service = Service {
        root: store.dir().join("executor-workspaces"),
        store,
        flow: binding::flow_from_env(),
        pi: binding::pi_from_env(),
        locks: Default::default(),
    };
    Router::new()
        .route("/v2/executor-attempts/{id}", get(inspect).put(start))
        .route("/v2/executor-attempts/{id}/cancel", post(cancel))
        .layer(DefaultBodyLimit::max(512 * 1024))
        .with_state(Arc::new(service))
}
type Reply = Result<Json<Value>, Error>;
async fn start(
    State(s): State<Arc<Service>>,
    Path(id): Path<String>,
    Json(body): Json<Start>,
) -> Reply {
    if body.work_instruction.encoding != "utf-8"
        || body.work_instruction.text.trim().is_empty()
        || body.work_instruction.text.len() > 256 * 1024
    {
        return Err(Error::Invalid("需要非空 UTF-8 指令，最多 256 KiB".into()));
    }
    run(s, id, Operation::Start(body)).await
}
async fn inspect(State(s): State<Arc<Service>>, Path(id): Path<String>) -> Reply {
    run(s, id, Operation::Inspect).await
}
async fn cancel(State(s): State<Arc<Service>>, Path(id): Path<String>) -> Reply {
    run(s, id, Operation::Cancel).await
}
enum Operation {
    Start(Start),
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
        let mut row = self
            .store
            .read(|db| Ok(db["executorAttempts"].get(id).cloned()))?;
        if let (Some(row), Operation::Start(body)) = (&row, &op) {
            if row["request"] != json!(body) {
                return Err(Error::Conflict("同一尝试 ID 已绑定其他输入".into()));
            }
        }

        if let Some(row) = &row {
            if row["result"]["artifactDirectoryId"].is_string() {
                return Ok(row["result"].clone());
            }
        }
        let backend = if let Some(row) = &row {
            let backend = binding::backend_for_row(row, self.flow.as_ref(), self.pi.as_ref())?;
            if matches!(
                (&backend, &op),
                (binding::Backend::Pi { .. }, Operation::Start(_))
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
            let Operation::Start(body) = &op else {
                return Err(Error::NotFound("尝试不存在".into()));
            };
            let target = binding::target(body)?;
            let (backend, config) =
                binding::resolve(&self.store, &target, self.flow.as_ref(), self.pi.as_ref())?;
            let store = self.store.clone();
            let root = self.root.clone();
            let key = id.to_owned();
            let patch = body.work_patch_id.clone();
            let digest = tokio::task::spawn_blocking(move || {
                files::prepare(&store, &root, &key, patch.as_deref())?;
                config
                    .as_ref()
                    .map(|c| binding::create_snapshot(&root, &key, c))
                    .transpose()
            })
            .await
            .map_err(|_| Error::Internal("工作区准备中断".into()))??;
            let new = json!({
                "request": body,
                "backend": backend.mode(),
                "configDigest": digest,
                "binding": backend.binding(),
                "result": {"attemptId":id,"status":"starting","artifactDirectoryRef":format!("artifacts:{id}")}
            });
            self.store.update(|db| {
                db["executorAttempts"][id] = new.clone();
                Ok(())
            })?;
            row = Some(new);
            backend
        };

        let row = row.expect("reserved");
        let (tool, args) = match op {
            Operation::Start(_) => (
                "executor_start",
                json!({"attemptId":id,"workInstruction":row["request"]["workInstruction"],"workspaceRef":format!("workspace:{id}"),"artifactDirectoryRef":format!("artifacts:{id}")}),
            ),
            Operation::Inspect => ("executor_inspect", json!({"attemptId":id})),
            Operation::Cancel => ("executor_cancel", json!({"attemptId":id})),
        };
        let answer = client::call(&backend, &self.root, tool, args)
            .await
            .and_then(|v| validate(id, v));
        let answer = match answer {
            Ok(v) => v,
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
