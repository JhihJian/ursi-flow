//! 目录版本只追加；发布校验与版本分配在同一次 Store 更新中完成。
mod agent;
mod definitions;
mod policy;
#[cfg(test)]
mod tests;

use super::{Error, Store};
use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use serde_json::{Map, Value, json};

type Reply = Result<Json<Value>, Error>;
type Collection = (Store, &'static str);

pub fn routes(store: Store) -> Router {
    let mut api = Router::new().route("/v2/agent-options", get(agent::options));
    for kind in ["resources", "executors"] {
        let collection = Router::new()
            .route("/", get(index).post(create))
            .route("/{id}", get(detail))
            .route("/{id}/revisions", get(history))
            .route("/{id}/revisions/{revision}", get(detail_revision))
            .route("/{id}/deactivate", post(disable))
            .with_state((store.clone(), kind));
        api = api.nest(&format!("/v2/{kind}"), collection);
    }
    api
}

async fn create(State((s, k)): State<Collection>, Json(body): Json<Value>) -> Reply {
    s.update(|db| publish(db, k, body)).map(Json)
}
async fn index(State((s, k)): State<Collection>) -> Reply {
    s.read(|db| list_latest(db, k)).map(Json)
}
async fn detail(State((s, k)): State<Collection>, Path(id): Path<String>) -> Reply {
    s.read(|db| latest(db, k, &id)).map(Json)
}
async fn history(State((s, k)): State<Collection>, Path(id): Path<String>) -> Reply {
    s.read(|db| Ok(Value::Array(versions(record(db, k, &id)?)?.clone())))
        .map(Json)
}
async fn detail_revision(
    State((s, k)): State<Collection>,
    Path((id, r)): Path<(String, u64)>,
) -> Reply {
    s.read(|db| version(db, k, &id, r).cloned()).map(Json)
}
async fn disable(State((s, k)): State<Collection>, Path(id): Path<String>) -> Reply {
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
fn publish(db: &mut Value, k: &str, body: Value) -> Result<Value, Error> {
    let id = definitions::id(&body)?;
    let n = match category(db, k)?.and_then(|map| map.get(id)) {
        Some(rec) => {
            require_active(db, k, id)?;
            versions(rec)?.len()
        }
        None => 0,
    };
    let (mut value, snapshot) = if k == "executors" && body.get("agent").is_some() {
        let snapshot = agent_preview(db, &body)?;
        if db["catalog"][k][id]
            .get("agentSnapshots")
            .is_some_and(|s| !s.is_object())
        {
            return Err(corrupt());
        }
        (body.clone(), Some(snapshot))
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
    if let Some(snapshot) = snapshot {
        db["catalog"][k][id]["agentSnapshots"][revision.to_string()] = snapshot;
    }
    Ok(value)
}
pub(super) fn agent_snapshot(db: &Value, id: &str, revision: u64) -> Result<Value, Error> {
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

pub(super) fn agent_preview(db: &Value, definition: &Value) -> Result<Value, Error> {
    agent::preview(db, definition)
}

fn deactivate(db: &mut Value, k: &str, id: &str) -> Result<Value, Error> {
    let mut detail = latest(db, k, id)?;
    db["catalog"][k][id]["active"] = false.into();
    detail["active"] = false.into();
    Ok(detail)
}
