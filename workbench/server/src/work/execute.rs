//! 执行工作包中已解析的动作。调用示例见 execute/API.md。
mod agent;
mod flow;
mod plan;
mod sandbox;
#[cfg(test)]
mod tests;

use super::{Error, Store};
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
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use ursi_flow_client::FlowClient;
use uuid::Uuid;

type Reply = Result<Json<Value>, Error>;
type Key = (String, String);

struct Runtime {
    store: Store,
    workspace: PathBuf,
    bin: Option<PathBuf>,
    flow: Option<FlowClient>,
    sandbox: Option<sandbox::Config>,
    agents: Mutex<HashMap<String, watch::Sender<bool>>>,
    processes: Arc<Semaphore>,
    calls: Arc<Semaphore>,
    ready: bool,
}

pub fn routes(store: Store, workspace: PathBuf, flow: Option<FlowClient>) -> Router {
    router(
        store,
        workspace,
        flow,
        std::env::var_os("URSI_AGENT_BIN").map(PathBuf::from),
        sandbox::Config::from_env(),
    )
}

fn router(
    store: Store,
    workspace: PathBuf,
    flow: Option<FlowClient>,
    bin: Option<PathBuf>,
    sandbox: Option<sandbox::Config>,
) -> Router {
    let ready = store.update(recover).is_ok();
    let rt = Runtime {
        store,
        workspace,
        flow,
        bin,
        sandbox,
        agents: Mutex::default(),
        processes: Arc::new(Semaphore::new(4)),
        calls: Arc::new(Semaphore::new(8)),
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
    if let Some(items) = db.get_mut("items").and_then(Value::as_object_mut) {
        for item in items.values_mut() {
            for attempt in history_mut(item)? {
                // Item detail also exposes this history. Remove legacy cwd values at the source.
                if let Some(path) = attempt["workspace"].as_str().filter(|p| p.starts_with('/')) {
                    if let Some(text) = attempt["output"].as_str() {
                        attempt["output"] = text.replace(path, "[workspace]").into();
                    }
                    attempt["workspace"] = "default".into();
                }
                if matches!(attempt["status"].as_str(), Some("starting" | "running")) {
                    attempt["interruptedStatus"] = attempt["status"].clone();
                    attempt["status"] = "unverified".into();
                    attempt["output"] = "服务已重启，执行可能已有副作用，请核实；不会重发".into();
                }
            }
        }
    }
    Ok(())
}

struct Outcome {
    status: &'static str,
    output: String,
}
impl Outcome {
    fn new(status: &'static str, output: impl Into<String>) -> Self {
        Self {
            status,
            output: output.into(),
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

impl Runtime {
    fn check(&self) -> Result<(), Error> {
        self.ready
            .then_some(())
            .ok_or_else(|| Error::Unavailable("尝试恢复失败，请检查存储后重启".into()))
    }
    fn redact(&self, text: &str) -> String {
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
            let a = attempt_mut(db, item, id)?;
            // A slow GET must never overwrite a confirmed terminal (including a concurrent stop).
            if !terminal(a) {
                a["status"] = outcome.status.into();
                a["output"] = self.redact(&outcome.output).into();
            }
            Ok(a.clone())
        })
    }
    fn sdk(&self) -> Result<FlowClient, Error> {
        self.flow
            .clone()
            .ok_or_else(|| Error::Unavailable("Flow 后端未启用".into()))
    }
    fn binary(&self) -> Result<&std::path::Path, Error> {
        self.bin
            .as_deref()
            .filter(|p| p.is_absolute() && p.is_file())
            .ok_or_else(|| {
                Error::Unavailable("需要管理员配置 URSI_AGENT_BIN 可执行文件的绝对路径".into())
            })
    }
}
fn slot(s: &Arc<Semaphore>) -> Result<OwnedSemaphorePermit, Error> {
    s.clone()
        .try_acquire_owned()
        .map_err(|_| Error::Unavailable("执行后端繁忙".into()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    action: String,
}

enum Dispatch {
    Agent(PathBuf, String, OwnedSemaphorePermit),
    Sandbox(String),
    Flow(FlowClient, flow::Call, OwnedSemaphorePermit),
}

async fn start(
    State(rt): State<Arc<Runtime>>,
    Path(item): Path<String>,
    Json(req): Json<Request>,
) -> Reply {
    rt.check()?;
    let key = (item, Uuid::new_v4().to_string());
    let (attempt, dispatch) = rt.store.update(|db| {
        let item = db["items"].get(&key.0).ok_or_else(|| Error::NotFound("工作项不存在".into()))?;
        let (plan, binding) = plan::resolve(item, &req.action)?;
        let (status, dispatch) = match plan {
            plan::Plan::Agent(prompt) => ("running", Dispatch::Agent(rt.binary()?.into(), prompt, slot(&rt.processes)?)),
            plan::Plan::Sandbox(prompt) => {
                rt.sandbox.as_ref().ok_or_else(|| Error::Unavailable("沙箱未配置".into()))?.reserve(db,&key.0)?;
                ("starting",Dispatch::Sandbox(prompt))
            }
            plan::Plan::Flow { id, revision, variables } => ("starting", Dispatch::Flow(rt.sdk()?, flow::Call::Start { flow: id, revision, variables, cwd: rt.workspace.clone() }, slot(&rt.calls)?)),
        };
        let mut attempt = json!({"id":key.1, "itemId":key.0, "action": req.action, "status":status, "executor":binding["executor"],
            "resources":binding["resources"], "workspace": "default", "backendRunId": key.1, "output":null});
        if matches!(dispatch, Dispatch::Sandbox(_)) {
            attempt["workspace"] = rt.sandbox.as_ref().unwrap().alias.clone().into();
            attempt["backendRunId"] = Value::Null;
        }
        history_mut(&mut db["items"][&key.0])?.push(attempt.clone());
        Ok((attempt, dispatch))
    })?;
    // No await between the durable append and dispatch. Dropping the HTTP future does not replay or abort the backend call.
    match dispatch {
        dispatch @ (Dispatch::Agent(..) | Dispatch::Sandbox(..)) => {
            let (tx, mut rx) = watch::channel(false);
            rt.agents.lock().unwrap().insert(key.1.clone(), tx);
            tokio::spawn(async move {
                let outcome = match dispatch {
                    Dispatch::Agent(bin, prompt, _permit) => {
                        agent::run(&bin, &rt.workspace, prompt, &mut rx, agent::DEADLINE).await
                    }
                    Dispatch::Sandbox(prompt) => {
                        sandbox::run(&rt, &key, rt.sandbox.as_ref().unwrap(), prompt, &mut rx).await
                    }
                    Dispatch::Flow(..) => unreachable!(),
                };
                if rt.record(&key, outcome).is_err() {
                    eprintln!("无法保存 Agent 尝试 {} 的结果", key.1);
                }
                rt.agents.lock().unwrap().remove(&key.1);
            });
            Ok(Json(attempt))
        }
        Dispatch::Flow(client, call, permit) => tokio::spawn(async move {
            match flow::call(client, key.1.clone(), call, permit).await {
                Ok(job) => rt.record(&key, flow::evidence(&attempt, &job)).map(Json),
                Err(e) => {
                    let status = if flow::rejected(&e) {
                        "failed"
                    } else {
                        "unverified"
                    };
                    rt.record(
                        &key,
                        Outcome::new(status, format!("Flow 启动: {}", e.kind())),
                    )?;
                    Err(flow::error(&e))
                }
            }
        })
        .await
        .map_err(|_| Error::Internal("Flow 启动任务异常".into()))?,
    }
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
    let mut daemon_evidence = None;
    match before["executor"]["kind"].as_str() {
        Some("flow") => {
            let run = flow::bound_run(&before)?;
            let result = flow::call(rt.sdk()?, run, flow::Call::Get, slot(&rt.calls)?).await;
            match flow::lookup(&before, result) {
                flow::Observation::Interrupted(code) => daemon_evidence = Some(code),
                flow::Observation::Reported(outcome) => {
                    rt.record(&key, outcome)?;
                    return Err(Error::Conflict(
                        "已按 daemon 状态刷新，请查看尝试详情".into(),
                    ));
                }
                flow::Observation::Inconclusive(reason) => {
                    return Err(Error::Conflict(reason.into()));
                }
            }
        }
        Some("agent") if before["executor"]["environment"] == "sandbox" => {
            let cfg = rt
                .sandbox
                .as_ref()
                .filter(|c| before["workspace"] == c.alias)
                .ok_or_else(|| Error::Conflict("不能核对原沙箱".into()))?;
            cfg.authorize(&key.0)?;
            if let Some(session) = before["backendRunId"].as_str() {
                let _permit = slot(&rt.calls)?;
                if !cfg.closed(session).await {
                    return Err(Error::Conflict("请管理员先核实并关闭原会话".into()));
                }
            } else if before["interruptedStatus"] != "starting" {
                return Err(Error::Conflict("缺少原会话证据".into()));
            }
        }
        Some("agent") => (),
        _ => return Err(Error::Conflict("无法核实未知执行器".into())),
    }
    rt.store.update(|db| {
        let a = attempt_mut(db, &key.0, &key.1)?;
        if *a != before {
            return Err(Error::Conflict("尝试已变更，请重新查询".into()));
        }
        a["verification"] = json!({"previousStatus":a["status"], "status":req.status,
            "evidence":rt.redact(req.evidence.trim()), "reason":rt.redact(req.reason.trim())});
        if let Some(code) = daemon_evidence {
            a["verification"]["daemonEvidence"] = json!({"op":"run.get", "runId":a["backendRunId"],
                "flowId":a["executor"]["flowId"], "flowRevision":a["executor"]["flowRevision"], "result":code});
        }
        a["status"] = json!(req.status);
        Ok(Json(a.clone()))
    })
}

async fn inspect(rt: Arc<Runtime>, key: Key, stop: bool) -> Reply {
    let attempt = rt.load(&key)?;
    if terminal(&attempt) {
        return Ok(Json(attempt));
    }
    if attempt["executor"]["kind"] == "flow" {
        if attempt["status"] == "starting" {
            return if stop {
                Err(Error::Conflict("Flow 正在受理，请稍后取消".into()))
            } else {
                Ok(Json(attempt))
            };
        }
        let op = if stop {
            flow::Call::Stop
        } else {
            flow::Call::Get
        };
        let run = flow::bound_run(&attempt)?;
        let client = rt.sdk()?;
        let permit = slot(&rt.calls)?;
        // Even a disconnected stop request must record what the daemon actually returned.
        return tokio::spawn(async move {
            let result = flow::call(client, run, op, permit).await;
            let outcome = if stop {
                match result {
                    Ok(job) => flow::evidence(&attempt, &job),
                    Err(_) => Outcome::new("unverified", "未获得 daemon 的运行证据；请稍后查询"),
                }
            } else {
                flow::lookup(&attempt, result).outcome()
            };
            rt.record(&key, outcome).map(Json)
        })
        .await
        .map_err(|_| Error::Internal("Flow 查询任务异常".into()))?;
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
