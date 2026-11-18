//! 目录版本只追加；发布校验与版本分配在同一次 Store 更新中完成。
mod definitions;
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
    let mut api = Router::new();
    for kind in ["resources", "executors", "packages"] {
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
pub(super) fn validate_delivery_name(name: &str) -> Result<(), Error> {
    if name.trim().is_empty()
        || matches!(name, "." | "..")
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
    {
        return Err(Error::Invalid("expected a plain file name".into()));
    }
    Ok(())
}

fn validate_deliverables(files: &Value) -> Result<(), Error> {
    let files = files
        .as_array()
        .ok_or_else(|| Error::Invalid("deliverables must be an array of file names".into()))?;
    let mut seen = std::collections::BTreeSet::new();
    for entry in files {
        let name = entry
            .as_str()
            .ok_or_else(|| Error::Invalid("deliverable name must be a string".into()))?;
        validate_delivery_name(name)?;
        if !seen.insert(name) {
            return Err(Error::Invalid(format!("duplicate deliverable: {name}")));
        }
    }
    Ok(())
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
    if k == "packages" {
        if let Some(files) = body.get("deliverables") {
            validate_deliverables(files)?;
        }
    }
    let mut value = definitions::build(db, k, &body)?;
    value["revision"] = (n as u64 + 1).into();
    // All fallible validation precedes the first write. No other db namespace is touched.
    if n == 0 {
        db["catalog"][k][id] = json!({"active":true,"revisions":[value]});
    } else {
        db["catalog"][k][id]["revisions"]
            .as_array_mut()
            .ok_or_else(corrupt)?
            .push(value.clone());
    }
    Ok(value)
}
fn deactivate(db: &mut Value, k: &str, id: &str) -> Result<Value, Error> {
    let mut detail = latest(db, k, id)?;
    db["catalog"][k][id]["active"] = false.into();
    detail["active"] = false.into();
    Ok(detail)
}

/// 返回发布时冻结的快照。新派工检查整个依赖链的当前状态，不重解析任何版本内容。
pub fn resolve(db: &Value, package: &str, revision: u64, for_new: bool) -> Result<Value, Error> {
    let frozen = version(db, "packages", package, revision)?;
    if for_new {
        require_active(db, "packages", package)?;
        for binding in frozen["actions"].as_object().ok_or_else(corrupt)?.values() {
            require_active(
                db,
                "executors",
                binding["executor"]["id"].as_str().ok_or_else(corrupt)?,
            )?;
            for resource in binding["resources"].as_array().ok_or_else(corrupt)? {
                require_active(
                    db,
                    "resources",
                    resource["id"].as_str().ok_or_else(corrupt)?,
                )?;
            }
        }
    }
    Ok(frozen.clone())
}

#[test]
fn invalid_deliverables_preserve_the_previous_package_revision() {
    let mut db = json!({});
    publish(&mut db, "executors", json!({"id":"pi","kind":"agent"})).unwrap();
    let mut pkg = json!({"id":"p","sop":"work","acceptance":"review",
        "deliverables":["核查 报告.txt"],"actions":{"a":{"executor":{"id":"pi","revision":1}}}});
    publish(&mut db, "packages", pkg.clone()).unwrap();
    let before = db.clone();
    for bad in [
        json!(null),
        json!("file.txt"),
        json!(["ok", 7]),
        json!([" "]),
        json!(["."]),
        json!([".."]),
        json!(["../x"]),
        json!(["dir\\x"]),
        json!(["x\0y"]),
        json!(["x", "x"]),
    ] {
        pkg["deliverables"] = bad;
        assert!(matches!(
            publish(&mut db, "packages", pkg.clone()),
            Err(Error::Invalid(_))
        ));
        assert_eq!(db, before);
    }
    pkg["deliverables"] = json!(["report.txt"]);
    assert_eq!(publish(&mut db, "packages", pkg).unwrap()["revision"], 2);
}
