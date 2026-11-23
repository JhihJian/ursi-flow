//! 目录版本只追加；发布校验与版本分配在同一次 Store 更新中完成。
mod agent;
mod definitions;
mod policy;
#[cfg(test)]
mod tests;

use super::{
    Error, Store,
    agent_backends::{Entry, Registry},
};
pub(super) use agent::SNAPSHOT_LIMIT;
use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use serde_json::{Map, Value, json};

type Reply = Result<Json<Value>, Error>;
type Collection = (Store, &'static str, Registry);

pub fn routes(store: Store, registry: Registry) -> Router {
    let mut api = Router::new()
        .route("/v2/agent-options", get(agent::options))
        .merge(
            Router::new()
                .route("/v2/node-executors/{id}/{revision}", get(node_executor))
                .with_state((store.clone(), registry.clone())),
        );
    for kind in ["resources", "executors"] {
        let collection = Router::new()
            .route("/", get(index).post(create))
            .route("/{id}", get(detail))
            .route("/{id}/revisions", get(history))
            .route("/{id}/revisions/{revision}", get(detail_revision))
            .route("/{id}/deactivate", post(disable))
            .with_state((store.clone(), kind, registry.clone()));
        api = api.nest(&format!("/v2/{kind}"), collection);
    }
    api
}

async fn node_executor(
    State((store, registry)): State<(Store, Registry)>,
    Path((id, revision)): Path<(String, u64)>,
) -> Reply {
    let (backend, _) = published_agent(&store, &registry, &id, revision)?;
    if !registry.supports_flow(&backend.id) {
        return Err(Error::Conflict("后端未声明 flowOutcome 能力".into()));
    }
    Ok(Json(json!({"id":id,"revision":revision})))
}

pub(super) fn consumer_routes(store: Store) -> Router {
    Router::new()
        .route("/v2/executors", get(consumer_index))
        .route("/v2/executors/{id}", get(consumer_detail))
        .route("/v2/executors/{id}/revisions", get(consumer_history))
        .route(
            "/v2/executors/{id}/revisions/{revision}",
            get(consumer_revision),
        )
        .with_state(store)
}

fn consumer_view(definition: &Value) -> Result<Value, Error> {
    let id = definitions::id(definition).map_err(|_| corrupt())?;
    let revision = definition["revision"]
        .as_u64()
        .filter(|r| *r > 0)
        .ok_or_else(corrupt)?;
    let mut view = json!({"id": id, "revision": revision});
    if definition["agent"].is_object() {
        view["agent"] = json!({});
    }
    Ok(view)
}

fn consumer_latest(rec: &Value) -> Result<Value, Error> {
    let mut view = consumer_view(versions(rec)?.last().ok_or_else(corrupt)?)?;
    view["active"] = active(rec)?.into();
    Ok(view)
}

async fn consumer_index(State(store): State<Store>) -> Reply {
    store
        .read(|db| {
            category(db, "executors")?
                .into_iter()
                .flat_map(Map::values)
                .map(consumer_latest)
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        })
        .map(Json)
}

async fn consumer_detail(State(store): State<Store>, Path(id): Path<String>) -> Reply {
    store
        .read(|db| consumer_latest(record(db, "executors", &id)?))
        .map(Json)
}

async fn consumer_history(State(store): State<Store>, Path(id): Path<String>) -> Reply {
    store
        .read(|db| {
            versions(record(db, "executors", &id)?)?
                .iter()
                .map(consumer_view)
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        })
        .map(Json)
}

async fn consumer_revision(
    State(store): State<Store>,
    Path((id, r)): Path<(String, u64)>,
) -> Reply {
    store
        .read(|db| consumer_view(version(db, "executors", &id, r)?))
        .map(Json)
}

async fn create(State((s, k, registry)): State<Collection>, Json(body): Json<Value>) -> Reply {
    tokio::task::spawn_blocking(move || s.update(|db| publish(s.dir(), db, k, body, &registry)))
        .await
        .map_err(|_| Error::Internal("定义发布任务中断".into()))?
        .map(Json)
}
async fn index(State((s, k, _)): State<Collection>) -> Reply {
    s.read(|db| list_latest(db, k)).map(Json)
}
async fn detail(State((s, k, _)): State<Collection>, Path(id): Path<String>) -> Reply {
    s.read(|db| latest(db, k, &id)).map(Json)
}
async fn history(State((s, k, _)): State<Collection>, Path(id): Path<String>) -> Reply {
    s.read(|db| Ok(Value::Array(versions(record(db, k, &id)?)?.clone())))
        .map(Json)
}
async fn detail_revision(
    State((s, k, _)): State<Collection>,
    Path((id, r)): Path<(String, u64)>,
) -> Reply {
    s.read(|db| version(db, k, &id, r).cloned()).map(Json)
}
async fn disable(State((s, k, _)): State<Collection>, Path(id): Path<String>) -> Reply {
    s.update(|db| deactivate(db, k, &id)).map(Json)
}

fn corrupt() -> Error {
    Error::Internal("目录数据损坏".into())
}
fn category<'a>(db: &'a Value, kind: &str) -> Result<Option<&'a Map<String, Value>>, Error> {
    let root = db.as_object().ok_or_else(corrupt)?;
    let Some(cat) = root.get("catalog") else {
        return Ok(None);
    };
    cat.as_object()
        .ok_or_else(corrupt)?
        .get(kind)
        .map(|v| v.as_object().ok_or_else(corrupt))
        .transpose()
}
fn record<'a>(db: &'a Value, kind: &str, id: &str) -> Result<&'a Value, Error> {
    category(db, kind)?
        .and_then(|c| c.get(id))
        .ok_or_else(|| Error::NotFound(format!("{kind}/{id} 不存在")))
}
fn versions(rec: &Value) -> Result<&Vec<Value>, Error> {
    rec["revisions"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(corrupt)
}
fn active(rec: &Value) -> Result<bool, Error> {
    rec["active"].as_bool().ok_or_else(corrupt)
}
fn require_active(db: &Value, k: &str, id: &str) -> Result<(), Error> {
    if active(record(db, k, id)?)? {
        Ok(())
    } else {
        Err(Error::Conflict(format!("{k}/{id} 已停用")))
    }
}
fn version<'a>(db: &'a Value, k: &str, id: &str, r: u64) -> Result<&'a Value, Error> {
    let index = r
        .checked_sub(1)
        .ok_or_else(|| Error::Invalid("revision 必须大于 0".into()))?;
    let history = versions(record(db, k, id)?)?;
    usize::try_from(index)
        .ok()
        .and_then(|i| history.get(i))
        .ok_or_else(|| Error::NotFound(format!("{k}/{id} 第 {r} 版不存在")))
}
pub(super) fn resolve_consumer_ref(store: &Store, reference: &Value) -> Result<(), Error> {
    let (id, revision) = definitions::reference(reference)?;
    store.read(|db| {
        require_active(db, "executors", id)?;
        version(db, "executors", id, revision).map(|_| ())
    })
}

#[test]
fn consumer_views_only_include_public_revision_metadata() {
    let plain = json!({"id":"worker","revision":1,"configSchema":[{"default":{"ref":"secret://vault/token"}}]});
    let agent = json!({"id":"worker","revision":2,"resources":[{"id":"private","revision":1}],
        "agent":{"backendId":"private-adapter","configPackageId":"private-package"}});
    let rec = json!({"active":false,"revisions":[plain, agent],"agentSnapshots":{"2":{"prompt":"private"}},
        "agentBindings":{"2":["private-adapter","/opt/private/bin","/opt/private/policy"]}});
    assert_eq!(
        consumer_view(&plain).unwrap(),
        json!({"id":"worker","revision":1})
    );
    assert_eq!(
        consumer_view(&agent).unwrap(),
        json!({"id":"worker","revision":2,"agent":{}})
    );
    assert_eq!(
        consumer_latest(&rec).unwrap(),
        json!({"id":"worker","revision":2,"agent":{},"active":false})
    );
}

fn latest(db: &Value, k: &str, id: &str) -> Result<Value, Error> {
    let rec = record(db, k, id)?;
    let mut value = versions(rec)?.last().ok_or_else(corrupt)?.clone();
    value
        .as_object_mut()
        .ok_or_else(corrupt)?
        .insert("active".into(), active(rec)?.into());
    Ok(value)
}
fn list_latest(db: &Value, k: &str) -> Result<Value, Error> {
    category(db, k)?
        .into_iter()
        .flat_map(Map::keys)
        .map(|id| latest(db, k, id))
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}
fn publish(
    store_dir: &std::path::Path,
    db: &mut Value,
    k: &str,
    body: Value,
    registry: &Registry,
) -> Result<Value, Error> {
    let id = definitions::id(&body)?;
    let n = match category(db, k)?.and_then(|map| map.get(id)) {
        Some(rec) => {
            require_active(db, k, id)?;
            versions(rec)?.len()
        }
        None => 0,
    };
    let (mut value, snapshot) = if k == "executors" && body.get("agent").is_some() {
        let snapshot = agent::preview(store_dir, db, &body)?;
        let backend = registry.select(body["agent"]["backendId"].as_str(), &snapshot)?;
        for table in ["agentSnapshots", "agentBindings"] {
            if db["catalog"][k][id]
                .get(table)
                .is_some_and(|s| !s.is_object())
            {
                return Err(corrupt());
            }
        }
        let mut public = body.clone();
        public["agent"]["backendId"] = json!(backend.id);
        (public, Some((snapshot, entry_binding(&backend))))
    } else {
        (definitions::build(db, k, &body)?, None)
    };
    let revision = n as u64 + 1;
    value["revision"] = revision.into();
    // All fallible validation precedes the first write. No other db namespace is touched.
    if n == 0 {
        db["catalog"][k][id] = json!({"active":true,"revisions":[value]});
    } else {
        db["catalog"][k][id]["revisions"]
            .as_array_mut()
            .ok_or_else(corrupt)?
            .push(value.clone());
    }
    if let Some((snapshot, binding)) = snapshot {
        db["catalog"][k][id]["agentSnapshots"][revision.to_string()] = snapshot;
        db["catalog"][k][id]["agentBindings"][revision.to_string()] = binding;
    }
    Ok(value)
}
pub(super) fn entry_binding(entry: &Entry) -> Value {
    json!(["acp-v2", entry.id, entry.bin, entry.policy])
}

fn agent_snapshot(db: &Value, id: &str, revision: u64) -> Result<Value, Error> {
    require_active(db, "executors", id)?;
    if version(db, "executors", id, revision)?
        .get("agent")
        .is_none()
    {
        return Err(Error::Invalid("该执行器修订未配置 Agent".into()));
    }
    record(db, "executors", id)?["agentSnapshots"]
        .get(revision.to_string())
        .cloned()
        .ok_or_else(corrupt)
}

pub(super) fn published_agent(
    store: &Store,
    registry: &Registry,
    id: &str,
    rev: u64,
) -> Result<(Entry, Value), Error> {
    store.read(|db| {
        let snapshot = agent_snapshot(db, id, rev)?;
        let agent = &version(db, "executors", id, rev)?["agent"];
        let requested = agent
            .get("backendId")
            .map(|v| v.as_str().ok_or_else(corrupt))
            .transpose()?;
        let backend_id = requested.unwrap_or("pi");
        let unavailable = || Error::Unavailable("原执行器后端不可用或绑定已变更".into());
        let entry = registry.lookup(backend_id).map_err(|_| unavailable())?;
        let bindings = &db["catalog"]["executors"][id];
        let bindings = bindings
            .get("agentBindings")
            .map(|v| v.as_object().ok_or_else(corrupt))
            .transpose()?;
        let key = rev.to_string();
        let binding = entry_binding(&entry);
        if bindings.and_then(|b| b.get(&key)) != Some(&binding) {
            return Err(unavailable());
        }
        Ok((entry, snapshot))
    })
}

pub(super) fn agent_preview(store: &Store, definition: &Value) -> Result<Value, Error> {
    store.read(|db| agent::preview(store.dir(), db, definition))
}

fn deactivate(db: &mut Value, k: &str, id: &str) -> Result<Value, Error> {
    let mut detail = latest(db, k, id)?;
    db["catalog"][k][id]["active"] = false.into();
    detail["active"] = false.into();
    Ok(detail)
}
