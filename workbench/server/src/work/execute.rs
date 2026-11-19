//! 执行工作包中已解析的动作。调用示例见 execute/API.md。
mod agent;
mod plan;
mod registry;
#[cfg(test)]
mod tests;

use super::{Error, Store, directories};
use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{oneshot, watch};
use ursi_flow_client::FlowClient;
use uuid::Uuid;

type Reply = Result<Json<Value>, Error>;
type Key = (String, String);

/// 平台分配给一次尝试的目录能力引用。标识不是宿主路径。
const WORKSPACE_ACCESS: &str = "read-write";
const WORKSPACE_PURPOSE: &str = "work-input";

struct Runtime {
    store: Store,
    workspace: PathBuf,
    /// 目录资源私有根的宿主路径，只用于从对外文本中剔除。
    artifacts: Option<PathBuf>,
    agents: Mutex<HashMap<String, watch::Sender<bool>>>,
    registry: Arc<registry::Registry>,
    ready: bool,
}

pub fn routes(store: Store, workspace: PathBuf, _flow: Option<FlowClient>) -> Router {
    router(
        store,
        workspace,
        std::env::var_os("URSI_AGENT_BIN").map(PathBuf::from),
    )
}

fn router(store: Store, workspace: PathBuf, bin: Option<PathBuf>) -> Router {
    let ready = store.update(recover).is_ok();
    let artifacts = directories::fs::root(store.dir()).ok();
    let rt = Runtime {
        store,
        workspace,
        artifacts,
        agents: Mutex::default(),
        registry: Arc::new(registry::Registry::local(bin)),
        ready,
    };
    Router::new()
        .route("/v2/items/{id}/attempts", get(list).post(start))
        .route("/v2/items/{id}/attempts/{attempt}", get(query))
        .route("/v2/items/{id}/attempts/{attempt}/cancel", post(cancel))
        .route("/v2/items/{id}/attempts/{attempt}/verify", post(verify))
        .with_state(Arc::new(rt))
}

fn recover(db: &mut Value) -> Result<(), Error> {
    let mut freeze = Vec::new();
    if let Some(items) = db.get_mut("items").and_then(Value::as_object_mut) {
        for item in items.values_mut() {
            for attempt in history_mut(item)? {
                migrate(attempt)?;
                if matches!(attempt["status"].as_str(), Some("starting" | "running")) {
                    attempt["interruptedStatus"] = attempt["status"].clone();
                    attempt["status"] = "unverified".into();
                    // 恢复提示单独存放，不得覆盖执行器留下的 output。
                    attempt["recoveryNotice"] =
                        "服务已重启，执行可能已有副作用，请核实；不会重发".into();
                    push_log(
                        attempt,
                        "attempt_interrupted",
                        "服务重启时尝试尚未结束，已转为待核实；不会重发",
                    );
                    let directory = attempt["artifactDirectory"]["id"]
                        .as_str()
                        .map(str::to_owned);
                    if let Some(id) = directory {
                        attempt["artifactDirectory"]["state"] = "frozen".into();
                        freeze.push(id);
                    }
                }
            }
        }
    }
    for id in freeze {
        directories::freeze(db, &id)?;
    }
    Ok(())
}

/// 旧记录只有工作区别名或宿主路径，缺少执行器契约字段。补成当前形状。
fn migrate(attempt: &mut Value) -> Result<(), Error> {
    let legacy = attempt["workspace"].as_str().map(str::to_owned);
    if let Some(text) = legacy {
        let id = if text.starts_with('/') {
            // Item detail also exposes this history. Remove legacy host paths at the source.
            if let Some(output) = attempt["output"].as_str() {
                attempt["output"] = output.replace(&text, "[workspace]").into();
            }
            "default".to_owned()
        } else {
            text
        };
        attempt["workspace"] = workspace_ref(&id);
    }
    if !attempt["workspace"]["id"].is_string() {
        attempt["workspace"] = workspace_ref("default");
    }
    for (field, value) in [
        ("workInstruction", Value::Null),
        ("artifactDirectory", Value::Null),
        ("executorLog", Value::Null),
        ("executorLogPage", Value::Null),
        ("configPackage", Value::Null),
    ] {
        if attempt.get(field).is_none() {
            attempt[field] = value;
        }
    }
    if !attempt["platformLog"].is_array() {
        attempt["platformLog"] = json!([]);
    }
    if attempt.get("executorIntegration").is_none() {
        let executor = &attempt["executor"];
        let is_previous_local_agent = executor.is_object()
            && !["kind", "environment", "flowId", "flowRevision"]
                .iter()
                .any(|field| executor.get(*field).is_some())
            && executor["id"].is_string()
            && executor["revision"]
                .as_u64()
                .is_some_and(|revision| revision > 0);
        if is_previous_local_agent {
            attempt["executorIntegration"] =
                json!({"id":registry::LOCAL_AGENT_ID,"revision":registry::LOCAL_AGENT_REVISION});
        }
    }
    Ok(())
}

fn workspace_ref(id: &str) -> Value {
    json!({"id": id, "access": WORKSPACE_ACCESS, "purpose": WORKSPACE_PURPOSE})
}

const CONFIG_ACCESS: &str = "read-only";
const CONFIG_PURPOSE: &str = "executor-config";

fn config_capability(id: &str) -> Value {
    json!({"id": id, "access": CONFIG_ACCESS, "purpose": CONFIG_PURPOSE})
}

fn config_ref(value: Option<&Value>, field: &str) -> Result<Value, Error> {
    let Some(value) = value else {
        return Ok(Value::Null);
    };
    if value.is_null() {
        return Ok(Value::Null);
    }
    let object = value
        .as_object()
        .ok_or_else(|| Error::Invalid(format!("{field} 必须是配置引用对象")))?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "id" | "revision"))
    {
        return Err(Error::Invalid(format!(
            "{field} 不能包含目录路径或其他宿主字段"
        )));
    }
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty() && !id.starts_with('/') && !id.contains(['\\', '/']))
        .ok_or_else(|| Error::Invalid(format!("{field}.id 必须是宿主无关的标识")))?;
    let revision = object
        .get("revision")
        .and_then(Value::as_u64)
        .filter(|revision| *revision > 0)
        .ok_or_else(|| Error::Invalid(format!("{field}.revision 必须是正整数")))?;
    Ok(json!({"id": id, "revision": revision}))
}

fn freeze_secrets(value: Option<&Value>) -> Result<Value, Error> {
    let Some(value) = value else {
        return Ok(json!({}));
    };
    let secrets = value
        .as_object()
        .ok_or_else(|| Error::Invalid("配置 secrets 必须是对象".into()))?;
    let mut frozen = serde_json::Map::new();
    for (name, secret) in secrets {
        let state = secret
            .as_object()
            .and_then(|object| object.get("state"))
            .and_then(Value::as_str);
        let state = match state {
            Some("internalRef" | "internal-reference" | "internal_reference") => "internalRef",
            Some("irreversible" | "redacted") => "irreversible",
            Some(_) => return Err(Error::Invalid(format!("配置 secret {name} 状态无效"))),
            // A provider may supply a value only before the attempt boundary.
            // The attempt keeps the irreversible state and never the value.
            None if secret.is_string()
                || secret
                    .as_object()
                    .is_some_and(|object| object.contains_key("value")) =>
            {
                "irreversible"
            }
            None if secret
                .as_object()
                .is_some_and(|object| object.contains_key("ref")) =>
            {
                "internalRef"
            }
            None => return Err(Error::Invalid(format!("配置 secret {name} 缺少状态"))),
        };
        // Never persist a value, locator, or provider-specific secret payload.
        frozen.insert(name.clone(), json!({"state": state}));
    }
    Ok(Value::Object(frozen))
}

/// Freeze only host-neutral configuration data. The mutable config package is
/// represented by a new per-attempt snapshot and capability reference.
fn freeze_config(
    item: &Value,
    binding: &Value,
    attempt: &str,
    snapshot: Option<&super::patches::ConfigPackageSnapshot>,
) -> Result<Value, Error> {
    let package = binding
        .get("configPackage")
        .filter(|value| value.is_object())
        .or_else(|| {
            item["packageSnapshot"]
                .get("configPackage")
                .filter(|value| value.is_object())
        })
        .or_else(|| item.get("configPackage").filter(|value| value.is_object()));
    let config = binding
        .get("config")
        .filter(|value| value.is_object())
        .or_else(|| item["packageSnapshot"].get("config"))
        .filter(|value| value.is_object())
        .or_else(|| item.get("config").filter(|value| value.is_object()));
    let has_config = package.is_some()
        || config.is_some()
        || item.get("configVersion").is_some()
        || item.get("configValues").is_some()
        || item.get("configSecrets").is_some();
    let source_ref = if let Some(snapshot) = snapshot {
        json!({"id": snapshot.source_package_id})
    } else {
        config_ref(
            package
                .and_then(|value| value.get("sourceRef"))
                .or_else(|| config.and_then(|value| value.get("sourceRef"))),
            "configPackage.sourceRef",
        )?
    };
    let values = package
        .and_then(|value| value.get("values"))
        .or_else(|| config.and_then(|value| value.get("values")))
        .or_else(|| item.get("configValues"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !values.is_object() {
        return Err(Error::Invalid("配置 values 必须是对象".into()));
    }
    let secrets = freeze_secrets(
        package
            .and_then(|value| value.get("secrets"))
            .or_else(|| config.and_then(|value| value.get("secrets")))
            .or_else(|| item.get("configSecrets")),
    )?;
    let version = package
        .and_then(|value| value.get("version").or_else(|| value.get("configVersion")))
        .or_else(|| {
            config.and_then(|value| value.get("version").or_else(|| value.get("configVersion")))
        })
        .or_else(|| item.get("configVersion"))
        .cloned()
        .or_else(|| source_ref.get("revision").cloned())
        .unwrap_or(Value::Null);
    let snapshot_ref = snapshot
        .map(|snapshot| {
            json!({
                "id": snapshot.snapshot_directory_id,
                "digest": snapshot.content_digest,
                "state": "frozen"
            })
        })
        .or_else(|| has_config.then(|| json!({"id": attempt, "revision": 1})))
        .unwrap_or(Value::Null);
    let capability = snapshot
        .map(|snapshot| config_capability(&snapshot.snapshot_directory_id))
        .or_else(|| has_config.then(|| config_capability(attempt)))
        .unwrap_or(Value::Null);
    Ok(json!({
        "version": version,
        "values": values,
        "secrets": secrets,
        "sourceRef": source_ref,
        "snapshotRef": snapshot_ref,
        "capability": capability,
    }))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// 追加一条平台记录日志。平台日志只记事件和已脱敏的摘要。
fn push_log(attempt: &mut Value, event: &str, message: &str) {
    let mut entries = attempt["platformLog"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    entries.push(json!({
        "sequence": entries.len() as u64 + 1,
        "occurredAt": now(),
        "source": "platform",
        "event": event,
        "message": message,
        "attemptStatus": attempt["status"].clone(),
    }));
    attempt["platformLog"] = Value::Array(entries);
}

struct Outcome {
    status: &'static str,
    output: String,
    /// 执行器自己产生的日志载荷。当前只承接 Agent 的标准输出。
    executor_log: Option<(&'static str, String)>,
}
impl Outcome {
    fn new(status: &'static str, output: impl Into<String>) -> Self {
        Self {
            status,
            output: output.into(),
            executor_log: None,
        }
    }
    fn logged(
        status: &'static str,
        output: impl Into<String>,
        source: &'static str,
        text: impl Into<String>,
    ) -> Self {
        Self {
            status,
            output: output.into(),
            executor_log: Some((source, text.into())),
        }
    }
}

fn history_mut(item: &mut Value) -> Result<&mut Vec<Value>, Error> {
    item.get_mut("attempts")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| Error::Internal("无效的 attempts 数组".into()))
}
fn history<'a>(db: &'a Value, item: &str) -> Result<&'a Vec<Value>, Error> {
    db["items"]
        .get(item)
        .ok_or_else(|| Error::NotFound("工作项不存在".into()))?["attempts"]
        .as_array()
        .ok_or_else(|| Error::Internal("无效的 attempts 数组".into()))
}
fn attempt_mut<'a>(db: &'a mut Value, item: &str, id: &str) -> Result<&'a mut Value, Error> {
    history_mut(db["items"].get_mut(item).ok_or_else(missing)?)?
        .iter_mut()
        .find(|a| a["id"] == id)
        .ok_or_else(missing)
}
fn missing() -> Error {
    Error::NotFound("执行尝试不存在".into())
}
fn terminal(attempt: &Value) -> bool {
    matches!(
        attempt["status"].as_str(),
        Some("succeeded" | "failed" | "cancelled")
    )
}

fn owned_by(attempt: &Value, item: &str) -> Result<(), Error> {
    if let Some(owner) = attempt.get("itemId").and_then(Value::as_str) {
        if owner != item {
            return Err(Error::Conflict("执行尝试不属于此工作项".into()));
        }
    }
    Ok(())
}

fn current_integration(registry: &registry::Registry, attempt: &Value) -> Result<(), Error> {
    let executor = attempt
        .get("executor")
        .and_then(Value::as_object)
        .ok_or_else(|| Error::Unavailable("尝试缺少当前 Agent 执行器绑定".into()))?;
    if ["kind", "environment", "flowId", "flowRevision"]
        .iter()
        .any(|field| executor.contains_key(*field))
    {
        return Err(Error::Unavailable(
            "该尝试使用尚未迁移的执行后端，当前不可用".into(),
        ));
    }
    if executor
        .keys()
        .any(|field| !matches!(field.as_str(), "id" | "revision" | "configSchema"))
    {
        return Err(Error::Unavailable(
            "尝试使用了未知执行器契约，当前不可用".into(),
        ));
    }
    if executor.get("id").and_then(Value::as_str).is_none()
        || executor
            .get("revision")
            .and_then(Value::as_u64)
            .is_none_or(|revision| revision == 0)
    {
        return Err(Error::Unavailable("尝试缺少固定逻辑执行器版本".into()));
    }
    let integration = attempt
        .get("executorIntegration")
        .and_then(Value::as_object)
        .ok_or_else(|| Error::Unavailable("尝试缺少冻结的执行器集成".into()))?;
    if integration
        .keys()
        .any(|field| !matches!(field.as_str(), "id" | "revision"))
        || integration
            .get("id")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        || integration
            .get("revision")
            .and_then(Value::as_u64)
            .is_none_or(|revision| revision == 0)
    {
        return Err(Error::Unavailable("尝试的执行器集成引用无效".into()));
    }
    if !registry.contains(
        integration["id"].as_str().unwrap(),
        integration["revision"].as_u64().unwrap(),
    ) {
        return Err(Error::Unavailable(
            "原执行器集成版本未注册，不会改派".into(),
        ));
    }
    Ok(())
}

impl Runtime {
    fn check(&self) -> Result<(), Error> {
        self.ready
            .then_some(())
            .ok_or_else(|| Error::Unavailable("尝试恢复失败，请检查存储后重启".into()))
    }
    fn redact(&self, text: &str) -> String {
        // 制品目录位于存储根之下，先剔除更长的前缀，避免只替换了工作区。
        let text = match &self.artifacts {
            Some(base) => text.replace(base.to_string_lossy().as_ref(), "[artifacts]"),
            None => text.to_owned(),
        };
        text.replace(self.workspace.to_string_lossy().as_ref(), "[workspace]")
    }
    fn load(&self, (item, id): &Key) -> Result<Value, Error> {
        self.check()?;
        self.store.read(|db| {
            history(db, item)?
                .iter()
                .find(|a| a["id"] == *id)
                .cloned()
                .ok_or_else(missing)
        })
    }
    fn record(&self, (item, id): &Key, outcome: Outcome) -> Result<Value, Error> {
        self.store.update(|db| {
            // Freeze first: the directory record and the attempt live in the same update.
            let directory = {
                let a = attempt_mut(db, item, id)?;
                if terminal(a) {
                    // A slow GET must never overwrite a confirmed terminal (including a concurrent stop).
                    return Ok(a.clone());
                }
                a["artifactDirectory"]["id"].as_str().map(str::to_owned)
            };
            if let Some(directory) = &directory {
                directories::freeze(db, directory)?;
            }
            let a = attempt_mut(db, item, id)?;
            a["status"] = outcome.status.into();
            a["output"] = self.redact(&outcome.output).into();
            if let Some((source, text)) = &outcome.executor_log {
                a["executorLog"] = json!({
                    "source": source,
                    "kind": "text",
                    "entries": [{
                        "sequence": 1,
                        "occurredAt": now(),
                        "stream": "stdout",
                        "text": self.redact(text),
                    }],
                });
            }
            if a["artifactDirectory"]["id"].is_string() {
                a["artifactDirectory"]["state"] = "frozen".into();
            }
            let message = match outcome.status {
                "succeeded" => "执行结束：成功",
                "failed" => "执行结束：失败",
                "cancelled" => "执行结束：已取消",
                _ => "执行结束：待核实",
            };
            push_log(a, "attempt_closed", message);
            if directory.is_some() {
                push_log(a, "artifact_directory_frozen", "制品目录已冻结");
            }
            Ok(a.clone())
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    action: String,
}

enum Dispatch {
    Agent(registry::Lease, String),
}

async fn start(
    State(rt): State<Arc<Runtime>>,
    Path(item): Path<String>,
    Json(req): Json<Request>,
) -> Reply {
    rt.check()?;
    let key = (item, Uuid::new_v4().to_string());
    let action = req.action;
    let (reply, receive) = oneshot::channel::<Result<Value, Error>>();
    // Keep registration and dispatch in a detached task. If the HTTP caller
    // disconnects while the blocking store operation is running, the attempt
    // still gets a backend and cannot become an unowned running record.
    tokio::spawn(async move {
        let allocation = {
            let rt = rt.clone();
            let key = key.clone();
            tokio::task::spawn_blocking(move || {
                // 配置包快照必须在 artifact 分配事务之外建立，避免在 Store 更新闭包中嵌套 Store 锁。
                let (config_package, lease) = rt.store.read(|db| {
                    let item = db["items"]
                        .get(&key.0)
                        .ok_or_else(|| Error::NotFound("工作项不存在".into()))?;
                    let (plan, _) = plan::resolve(item, &action)?;
                    let package = plan::config_package(item, &action)?;
                    let lease = rt
                        .registry
                        .select(plan.requirements())
                        .map_err(registry::selection_error)?;
                    Ok((package, lease))
                })?;
                let config_snapshot = config_package
                    .as_deref()
                    .map(|package_id| {
                        super::patches::snapshot_config_package(&rt.store, &key.1, package_id)
                    })
                    .transpose()?;
                directories::allocate(
                    &rt.store,
                    directories::Rules::default(),
                    |_| Ok(()),
                    |db, directory| {
                        reserve(
                            lease,
                            db,
                            directory,
                            &key,
                            &action,
                            config_snapshot.as_ref(),
                        )
                    },
                )
            })
            .await
            .map_err(|_| Error::Internal("执行启动任务中断".into()))
        };
        let allocation = match allocation {
            Ok(result) => result,
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
        let (attempt, dispatch) = match allocation {
            Ok(result) => result,
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
        let response = attempt.clone();
        match dispatch {
            Dispatch::Agent(lease, prompt) => {
                let directory = match attempt["artifactDirectory"]["id"].as_str() {
                    Some(id) => id.to_owned(),
                    None => {
                        let _ = reply.send(Err(Error::Internal("尝试缺少制品目录引用".into())));
                        return;
                    }
                };
                let config_directory = attempt["configPackage"]["snapshotRef"]["id"]
                    .as_str()
                    .map(str::to_owned);
                let (cancel, mut rx) = watch::channel(false);
                rt.agents.lock().unwrap().insert(key.1.clone(), cancel);
                let worker_rt = rt.clone();
                let worker_key = key.clone();
                tokio::spawn(async move {
                    let outcome = match directories::path(&worker_rt.store, &directory) {
                        Ok(artifact) => {
                            let config = config_directory
                                .as_deref()
                                .map(|id| directories::path(&worker_rt.store, id))
                                .transpose();
                            match config {
                                Ok(config) => {
                                    lease
                                        .run(
                                            &worker_rt.workspace,
                                            &artifact,
                                            prompt,
                                            config.as_deref(),
                                            &mut rx,
                                        )
                                        .await
                                }
                                Err(_) => Outcome::new("failed", "配置包快照不可用"),
                            }
                        }
                        Err(_) => Outcome::new("failed", "制品目录不可用"),
                    };
                    if worker_rt.record(&worker_key, outcome).is_err() {
                        eprintln!("无法保存 Agent 尝试 {} 的结果", worker_key.1);
                    }
                    worker_rt.agents.lock().unwrap().remove(&worker_key.1);
                });
            }
        }
        let _ = reply.send(Ok(response));
    });
    let attempt = receive
        .await
        .map_err(|_| Error::Internal("执行启动任务中断".into()))??;
    Ok(Json(attempt))
}

/// 在同一笔存储更新中校验工作项状态、冻结输入与制品引用并追加尝试。
fn reserve(
    lease: registry::Lease,
    db: &mut Value,
    directory: &str,
    key: &Key,
    action: &str,
    config_snapshot: Option<&super::patches::ConfigPackageSnapshot>,
) -> Result<(Value, Dispatch), Error> {
    let item = db["items"]
        .get(&key.0)
        .ok_or_else(|| Error::NotFound("工作项不存在".into()))?;
    let (plan, binding) = plan::resolve(item, action)?;
    let config_package = freeze_config(item, &binding, &key.1, config_snapshot)?;
    let instruction = plan.instruction();
    let integration = json!({"id": lease.id, "revision": lease.revision});
    let (status, workspace, dispatch) = match plan {
        plan::Plan::Text(prompt, _) => ("running", "default", Dispatch::Agent(lease, prompt)),
    };
    let mut attempt = json!({
        "id": key.1,
        "itemId": key.0,
        "action": action,
        "status": status,
        "executor": binding["executor"],
        "executorIntegration": integration,
        "resources": binding["resources"],
        "workspace": workspace_ref(workspace),
        "workInstruction": {"text": instruction, "encoding": "utf-8"},
        "configPackage": config_package,
        "artifactDirectory": {"id": directory, "state": "writable"},
        "platformLog": [],
        "executorLog": Value::Null,
        "executorLogPage": Value::Null,
        "backendRunId": key.1,
        "output": null,
    });
    push_log(
        &mut attempt,
        "attempt_created",
        "已分配 workspace 与制品目录，并冻结工作指令",
    );
    history_mut(&mut db["items"][&key.0])?.push(attempt.clone());
    Ok((attempt, dispatch))
}

async fn list(State(rt): State<Arc<Runtime>>, Path(item): Path<String>) -> Reply {
    rt.check()?;
    rt.store
        .read(|db| Ok(Json(Value::Array(history(db, &item)?.clone()))))
}
async fn query(State(rt): State<Arc<Runtime>>, Path(key): Path<Key>) -> Reply {
    inspect(rt, key, false).await
}
async fn cancel(State(rt): State<Arc<Runtime>>, Path(key): Path<Key>) -> Reply {
    inspect(rt, key, true).await
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum VerifiedStatus {
    Failed,
    Cancelled,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Verification {
    status: VerifiedStatus,
    evidence: String,
    reason: String,
}

async fn verify(
    State(rt): State<Arc<Runtime>>,
    Path(key): Path<Key>,
    Json(req): Json<Verification>,
) -> Reply {
    let before = rt.load(&key)?;
    owned_by(&before, &key.0)?;
    current_integration(&rt.registry, &before)?;
    if before["status"] != "unverified" {
        return Err(Error::Conflict("仅可人工核实待核实的尝试".into()));
    }
    for text in [&req.reason, &req.evidence] {
        if text.trim().is_empty() || text.len() > 4096 {
            return Err(Error::Invalid(
                "核实证据和原因各需 1 至 4096 字节的非空文本".into(),
            ));
        }
    }
    rt.store.update(|db| {
        let directory = {
            let a = attempt_mut(db, &key.0, &key.1)?;
            if *a != before {
                return Err(Error::Conflict("尝试已变更，请重新查询".into()));
            }
            a["artifactDirectory"]["id"].as_str().map(str::to_owned)
        };
        if let Some(directory) = directory {
            directories::freeze(db, &directory)?;
        }
        let a = attempt_mut(db, &key.0, &key.1)?;
        a["verification"] = json!({"previousStatus":a["status"], "status":req.status,
            "evidence":rt.redact(req.evidence.trim()), "reason":rt.redact(req.reason.trim())});
        a["status"] = json!(req.status);
        if a["artifactDirectory"]["id"].is_string() {
            a["artifactDirectory"]["state"] = "frozen".into();
        }
        push_log(
            a,
            "attempt_verified",
            "已记录人工核实结论，原制品目录保持冻结",
        );
        Ok(Json(a.clone()))
    })
}

async fn inspect(rt: Arc<Runtime>, key: Key, stop: bool) -> Reply {
    let attempt = rt.load(&key)?;
    owned_by(&attempt, &key.0)?;
    current_integration(&rt.registry, &attempt)?;
    if terminal(&attempt) {
        return Ok(Json(attempt));
    }
    if stop {
        let tx = rt.agents.lock().unwrap().get(&key.1).cloned();
        if let Some(tx) = tx {
            tx.send_replace(true);
            tx.closed().await;
        }
        let latest = rt.load(&key)?;
        if !terminal(&latest) {
            return Err(Error::Conflict("无法确认取消，没有可用的执行句柄".into()));
        }
        return Ok(Json(latest));
    }
    Ok(Json(attempt))
}
