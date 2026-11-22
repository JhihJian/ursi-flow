//! 工作包生成器只追加修订。保留原工作存储中的目录键和修订正文。
use super::{Error, Store};
use axum::{
    Json, Router,
    extract::{Path, State},
    routing::get,
};
use serde_json::{Map, Value, json};
use std::collections::HashSet;

pub(super) const GENERATORS: &str = "work-patch-generators";
type Reply = Result<Json<Value>, Error>;

pub(super) fn routes(store: Store) -> Router {
    let collection = Router::new()
        .route("/", get(index).post(create))
        .route("/{id}", get(detail))
        .route("/{id}/revisions", get(history))
        .route("/{id}/revisions/{revision}", get(detail_revision))
        .with_state(store);
    Router::new().nest(&format!("/v2/{GENERATORS}"), collection)
}

async fn create(State(store): State<Store>, Json(body): Json<Value>) -> Reply {
    tokio::task::spawn_blocking(move || store.update(|db| publish(db, &body)))
        .await
        .map_err(|_| Error::Internal("定义发布任务中断".into()))?
        .map(Json)
}

async fn index(State(store): State<Store>) -> Reply {
    store.read(|db| {
        let rows = table(db)?
            .into_iter()
            .flat_map(Map::values)
            .map(latest)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Json(Value::Array(rows)))
    })
}

async fn detail(State(store): State<Store>, Path(id): Path<String>) -> Reply {
    store.read(|db| latest(record(db, &id)?)).map(Json)
}

async fn history(State(store): State<Store>, Path(id): Path<String>) -> Reply {
    store
        .read(|db| Ok(Value::Array(versions(record(db, &id)?)?.clone())))
        .map(Json)
}

async fn detail_revision(
    State(store): State<Store>,
    Path((id, revision)): Path<(String, u64)>,
) -> Reply {
    store
        .read(|db| version(db, &id, revision).cloned())
        .map(Json)
}

fn corrupt() -> Error {
    Error::Internal("目录数据损坏".into())
}

fn table(db: &Value) -> Result<Option<&Map<String, Value>>, Error> {
    let Some(catalog) = db.as_object().ok_or_else(corrupt)?.get("catalog") else {
        return Ok(None);
    };
    catalog
        .as_object()
        .ok_or_else(corrupt)?
        .get(GENERATORS)
        .map(|v| v.as_object().ok_or_else(corrupt))
        .transpose()
}

fn record<'a>(db: &'a Value, id: &str) -> Result<&'a Value, Error> {
    table(db)?
        .and_then(|t| t.get(id))
        .ok_or_else(|| Error::NotFound(format!("{GENERATORS}/{id} 不存在")))
}

fn versions(record: &Value) -> Result<&Vec<Value>, Error> {
    record["revisions"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(corrupt)
}

fn active(record: &Value) -> Result<bool, Error> {
    record["active"].as_bool().ok_or_else(corrupt)
}

fn require_active(record: &Value, id: &str) -> Result<(), Error> {
    if active(record)? {
        Ok(())
    } else {
        Err(Error::Conflict(format!("{GENERATORS}/{id} 已停用")))
    }
}

fn latest(record: &Value) -> Result<Value, Error> {
    let mut value = versions(record)?.last().ok_or_else(corrupt)?.clone();
    value
        .as_object_mut()
        .ok_or_else(corrupt)?
        .insert("active".into(), active(record)?.into());
    Ok(value)
}

fn version<'a>(db: &'a Value, id: &str, revision: u64) -> Result<&'a Value, Error> {
    let index = revision
        .checked_sub(1)
        .ok_or_else(|| Error::Invalid("revision 必须大于 0".into()))?;
    let rows = versions(record(db, id)?)?;
    usize::try_from(index)
        .ok()
        .and_then(|i| rows.get(i))
        .ok_or_else(|| Error::NotFound(format!("{GENERATORS}/{id} 第 {revision} 版不存在")))
}

pub(super) fn generator<'a>(db: &'a Value, id: &str, revision: u64) -> Result<&'a Value, Error> {
    require_active(record(db, id)?, id)?;
    version(db, id, revision)
}

fn text<'a>(body: &'a Value, key: &str) -> Result<&'a str, Error> {
    body[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| Error::Invalid(format!("{key} 必须是非空字符串")))
}

fn publish(db: &mut Value, body: &Value) -> Result<Value, Error> {
    let id = text(body, "id")?;
    if id.len() > 128
        || matches!(id, "." | "..")
        || !id
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(Error::Invalid("需要不含路径的名称".into()));
    }
    let count = match table(db)?.and_then(|t| t.get(id)) {
        Some(record) => {
            require_active(record, id)?;
            versions(record)?.len()
        }
        None => 0,
    };
    let mut value = definition(body, id)?;
    value["revision"] = (count as u64 + 1).into();
    let record = &mut db["catalog"][GENERATORS][id];
    if count == 0 {
        *record = json!({"active":true, "revisions":[value]});
    } else {
        record["revisions"]
            .as_array_mut()
            .ok_or_else(corrupt)?
            .push(value.clone());
    }
    Ok(value)
}

fn definition(body: &Value, id: &str) -> Result<Value, Error> {
    let fields = body
        .as_object()
        .ok_or_else(|| Error::Invalid("需要 JSON 对象".into()))?;
    if fields
        .keys()
        .any(|k| !matches!(k.as_str(), "id" | "name" | "aliases" | "script"))
    {
        return Err(Error::Invalid("定义含有不支持的字段".into()));
    }
    let name = text(body, "name")?.trim();
    if name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "包名需为 1 至 80 个字符，且不含控制字符".into(),
        ));
    }
    let script = text(body, "script")?;
    if script.len() > 65536 {
        return Err(Error::Invalid("Python 脚本超过 64 KiB".into()));
    }
    let aliases = body["aliases"]
        .as_array()
        .filter(|rows| rows.len() <= 32)
        .ok_or_else(|| Error::Invalid("aliases 必须是含至多 32 项的数组".into()))?;
    let mut unique = HashSet::new();
    for alias in aliases {
        let alias = alias
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.trim() == *s
                    && !s.chars().any(char::is_control)
            })
            .ok_or_else(|| Error::Invalid("输入别名无效".into()))?;
        if !unique.insert(alias) {
            return Err(Error::Invalid("输入别名重复".into()));
        }
    }
    if id == "new" {
        return Err(Error::Invalid("生成器标识不能为 new".into()));
    }
    Ok(json!({"id":id,"name":name,"aliases":aliases,"script":script}))
}

#[cfg(test)]
mod tests;
