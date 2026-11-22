//! Explicit runs are registered before conversion and published with their output.
use super::{Binding, GeneratorRef, Recipe, Resource, convert, find, generate, resolve};
use crate::work::{Error, Store, directories, generators, patches};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use ursi_mcp::McpPlatform;
use uuid::Uuid;

const RUNS: &str = "workPatchGenerationRuns";

#[derive(Clone)]
struct Service {
    store: Store,
    platform: McpPlatform,
    slots: Arc<Semaphore>,
}

pub(super) fn routes(store: Store, platform: McpPlatform) -> Router {
    Router::new()
        .route("/v2/work-patch-generation-runs", get(list))
        .route(
            "/v2/work-patch-generation-runs/{id}",
            get(detail).put(start),
        )
        .layer(DefaultBodyLimit::max(256 * 1024))
        .with_state(Service {
            store,
            platform,
            slots: Arc::new(Semaphore::new(4)),
        })
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum Request {
    WorkItem(WorkItem),
    Trial(Trial),
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkItem {
    work_item_id: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Trial {
    generator: GeneratorRef,
    resources: Vec<Resource>,
}

struct Job {
    row: Value,
    item: Option<Value>,
    recipe: Recipe,
    _permit: OwnedSemaphorePermit,
}

fn internal() -> Error {
    Error::Internal("生成运行记录不可用".into())
}
fn missing() -> Error {
    Error::NotFound("生成运行不存在".into())
}
fn run_id(id: &str) -> Result<(), Error> {
    if Uuid::parse_str(id).is_ok_and(|v| {
        v.get_version_num() == 4 && v.get_variant() == uuid::Variant::RFC4122 && v.to_string() == id
    }) {
        Ok(())
    } else {
        Err(Error::Invalid("runId 必须是小写 UUID v4".into()))
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn register(service: &Service, id: &str, input: Request) -> Result<(Value, Option<Job>), Error> {
    let request = json!(&input);
    service.store.update(|db| {
        if let Some(entry) = db[RUNS].get(id) {
            if entry["request"] != request {
                return Err(Error::Conflict("该 runId 已用于其他请求".into()));
            }
            return Ok((entry["run"].clone(), None));
        }
        let (binding, item) = match input {
            Request::WorkItem(input) => {
                let item = find(db, &input.work_item_id)?;
                if item["generator"].is_null() {
                    return Err(Error::Invalid("工作项尚未绑定生成器".into()));
                }
                let binding: Binding = serde_json::from_value(item["generator"].clone()).map_err(|_| internal())?;
                (binding, Some(item.clone()))
            }
            Request::Trial(Trial { generator, resources }) => {
                (Binding { id: generator.id, revision: generator.revision, resources }, None)
            }
        };
        let generator = resolve(db, &binding.id, binding.revision, &binding.resources)?;
        let permit = service.slots.clone().try_acquire_owned()
            .map_err(|_| Error::Unavailable("生成任务已满，请稍后重试".into()))?;
        let mut row = json!({"id":id,"generator":{"id":binding.id,"revision":binding.revision},"resources":binding.resources,"status":"running","startedAt":now(),"initiator":"workbench-admin"});
        if let Some(item) = &item {
            row["workItemId"] = item["id"].clone();
            row["workItemTitle"] = item["title"].clone();
            row["workItemRevision"] = item["revision"].clone();
        }
        let recipe = Recipe { script: generator["script"].as_str().ok_or_else(internal)?.into(), resources: binding.resources };
        db[RUNS][id] = json!({"request":request,"run":row});
        Ok((row.clone(), Some(Job { row, item, recipe, _permit: permit })))
    })
}

async fn start(
    State(service): State<Service>,
    Path(id): Path<String>,
    Json(input): Json<Request>,
) -> Result<Json<Value>, Error> {
    run_id(&id)?;
    // Admission and dispatch are independent of the HTTP connection.
    tokio::spawn(async move {
        let state = service.clone();
        let (row, job) = tokio::task::spawn_blocking(move || register(&state, &id, input))
            .await
            .map_err(|_| internal())??;
        if let Some(job) = job {
            tokio::spawn(execute(service, job));
        }
        Ok(Json(row))
    })
    .await
    .map_err(|_| internal())?
}

async fn execute(service: Service, job: Job) {
    let mut progress = convert::Progress::default();
    let output = convert::execute(
        &service.platform,
        job.item.as_ref(),
        &job.recipe,
        &mut progress,
    )
    .await;
    let result = tokio::task::spawn_blocking(move || {
        let id = job.row["id"].as_str().ok_or_else(internal)?;
        let (stage, error) = match output {
            Ok(output) => match publish(&service.store, &job, output) {
                Ok(()) => return Ok(()),
                Err(e) => ("publish", e),
            },
            Err(e) => (progress.stage, e),
        };
        // Persist only safe diagnostics, not arbitrary upstream error text.
        let message = match (stage, error) {
            ("read", Error::NotFound(_)) => "输入引用的 MCP 服务不存在".into(),
            ("read", _) => "无法读取 MCP 资源，请检查服务、授权与输入限额".into(),
            (_, Error::Internal(_)) => "生成服务内部错误".into(),
            (
                _,
                Error::Invalid(s) | Error::Unavailable(s) | Error::Conflict(s) | Error::NotFound(s),
            ) => s,
        };
        service.store.update(|db| {
            let row = running(db, id)?;
            row["status"] = json!("failed");
            row["finishedAt"] = json!(now());
            row["evidence"] = json!(progress.evidence);
            row["error"] = json!({"stage":stage,"message":message});
            Ok(())
        })
    })
    .await;
    if !matches!(result, Ok(Ok(()))) {
        eprintln!("工作包生成：无法保存运行终态，重启后可查回中断状态");
    }
}

fn running<'a>(db: &'a mut Value, id: &str) -> Result<&'a mut Value, Error> {
    db[RUNS]
        .get_mut(id)
        .and_then(|entry| entry.get_mut("run"))
        .filter(|row| row["status"] == "running")
        .ok_or_else(internal)
}

fn publish(store: &Store, job: &Job, output: convert::Generated) -> Result<(), Error> {
    let id = job.row["id"].as_str().ok_or_else(internal)?;
    let generator = &job.row["generator"];
    let gen_id = generator["id"].as_str().ok_or_else(internal)?;
    let revision = generator["revision"].as_u64().ok_or_else(internal)?;
    let mut provenance = output.provenance;
    provenance["runId"] = json!(id);
    provenance["generator"] = generator.clone();
    let manifest: Vec<_> = output.files.iter().map(|(path, bytes)| json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes))})).collect();
    directories::allocate(
        store,
        directories::Rules::default(),
        |root| generate::seed(root, &output.files),
        |db, directory_id| {
            generators::generator(db, gen_id, revision)?;
            let mut result =
                json!({"name":output.name,"directoryId":directory_id,"files":manifest});
            if let Some(item) = &job.item {
                let item_id = item["id"].as_str().ok_or_else(internal)?;
                if find(db, item_id).ok().map(|row| &row["revision"]) != Some(&item["revision"]) {
                    return Err(Error::Conflict("工作项已修改或删除，生成结果未发布".into()));
                }
                let patch = patches::register_generated(
                    db,
                    output.name,
                    directory_id,
                    item_id,
                    provenance.clone(),
                )?;
                result["workPatchId"] = patch["id"].clone();
            } else {
                directories::freeze(db, directory_id)?;
            }
            let row = running(db, id)?;
            row["status"] = json!("succeeded");
            row["finishedAt"] = json!(now());
            row["evidence"] = provenance["resources"].clone();
            row["result"] = result;
            Ok(())
        },
    )
}

async fn detail(
    State(service): State<Service>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    run_id(&id)?;
    service.store.read(|db| {
        db[RUNS]
            .get(id)
            .map(|entry| Json(entry["run"].clone()))
            .ok_or_else(missing)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Filter {
    generator_id: Option<String>,
    work_item_id: Option<String>,
    offset: Option<usize>,
}

async fn list(
    State(service): State<Service>,
    Query(query): Query<Filter>,
) -> Result<Json<Value>, Error> {
    service.store.read(|db| {
        let mut rows: Vec<_> = db[RUNS]
            .as_object()
            .into_iter()
            .flat_map(|m| m.values())
            .map(|entry| &entry["run"])
            .filter(|row| {
                query
                    .generator_id
                    .as_ref()
                    .is_none_or(|id| row["generator"]["id"] == id.as_str())
            })
            .filter(|row| {
                query
                    .work_item_id
                    .as_ref()
                    .is_none_or(|id| row["workItemId"] == id.as_str())
            })
            .collect();
        rows.sort_unstable_by(|a, b| {
            (b["startedAt"].as_u64(), b["id"].as_str())
                .cmp(&(a["startedAt"].as_u64(), a["id"].as_str()))
        });
        Ok(Json(json!(
            rows.into_iter()
                .skip(query.offset.unwrap_or(0))
                .take(100)
                .collect::<Vec<_>>()
        )))
    })
}

pub(in crate::work) fn recover(store: &Store) -> Result<(), Error> {
    let pending = store.read(|db| {
        Ok(db[RUNS]
            .as_object()
            .is_some_and(|m| m.values().any(|entry| entry["run"]["status"] == "running")))
    })?;
    if pending {
        store.update(|db| {
            for entry in db[RUNS].as_object_mut().ok_or_else(internal)?.values_mut() {
                let row = &mut entry["run"];
                if row["status"] == "running" {
                    row["status"] = json!("interrupted");
                    row["finishedAt"] = json!(now());
                    row["error"] = json!({"stage":"interrupted","message":"服务重启，生成已中断"});
                }
            }
            Ok(())
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
