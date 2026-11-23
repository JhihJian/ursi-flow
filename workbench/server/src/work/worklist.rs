//! 工作清单管理可独立编辑的事项，不包含生成流程。
mod cleanup;
mod projects;
#[cfg(test)]
mod tests;

use super::{Error, Store, patches};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use uuid::Uuid;

const TABLE: &str = "workListItems";

/// 启动时执行自有数据的一次性清理。
pub(super) fn recover(store: &Store) -> Result<(), Error> {
    cleanup::recover(store)
}

pub(super) fn routes(store: Store) -> Router {
    Router::new()
        .route("/v2/work-items", get(list).post(create))
        .route(
            "/v2/work-items/{id}",
            get(detail).put(replace).delete(remove),
        )
        .merge(projects::routes())
        .with_state(store)
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Category {
    #[default]
    OneTime,
    Continuous,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    #[default]
    Pending,
    Active,
    Completed,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Definition {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default, deserialize_with = "present")]
    category: Option<Category>,
    #[serde(default, deserialize_with = "present")]
    status: Option<Status>,
    revision: Option<u64>,
}

// An omitted dimension is allowed, but an explicit null is not an enum value.
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

impl Definition {
    fn row(&self, id: &str, revision: u64, previous: Option<&Value>) -> Result<Value, Error> {
        let title = self.title.trim();
        if title.is_empty() || title.chars().any(char::is_control) {
            return Err(Error::Invalid("工作标题不能为空或包含控制字符".into()));
        }
        let category = self
            .category
            .map(|v| json!(v))
            .or_else(|| previous.map(|r| r["category"].clone()))
            .unwrap_or_else(|| json!(Category::default()));
        let status = self
            .status
            .map(|v| json!(v))
            .or_else(|| previous.map(|r| r["status"].clone()))
            .unwrap_or_else(|| json!(Status::default()));
        Ok(
            json!({"id":id,"title":title,"description":self.description,"category":category,"status":status,"revision":revision}),
        )
    }
}

fn corrupt() -> Error {
    Error::Internal("工作清单记录损坏".into())
}
fn missing() -> Error {
    Error::NotFound("工作清单项不存在".into())
}
fn table_mut(db: &mut Value) -> Result<&mut Map<String, Value>, Error> {
    db.as_object_mut()
        .ok_or_else(corrupt)?
        .entry(TABLE)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(corrupt)
}
pub(super) fn find<'a>(db: &'a Value, id: &str) -> Result<&'a Value, Error> {
    db[TABLE].get(id).ok_or_else(missing)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Filter {
    category: Option<Category>,
    status: Option<Status>,
}
async fn list(
    State(store): State<Store>,
    Query(filter): Query<Filter>,
) -> Result<Json<Value>, Error> {
    let category = filter.category.map(|c| json!(c));
    let status = filter.status.map(|s| json!(s));
    store.read(|db| {
        let Some(rows) = db.get(TABLE) else {
            return Ok(Json(json!([])));
        };
        let rows: Vec<_> = rows
            .as_object()
            .ok_or_else(corrupt)?
            .values()
            .filter(|row| category.as_ref().is_none_or(|c| c == &row["category"]))
            .filter(|row| status.as_ref().is_none_or(|s| s == &row["status"]))
            .collect();
        Ok(Json(json!(rows)))
    })
}
async fn detail(State(store): State<Store>, Path(id): Path<String>) -> Result<Json<Value>, Error> {
    store.read(|db| Ok(Json(find(db, &id)?.clone())))
}
async fn create(
    State(store): State<Store>,
    Json(input): Json<Definition>,
) -> Result<Json<Value>, Error> {
    store.update(|db| Ok(Json(insert_item(db, input)?)))
}

fn insert_item(db: &mut Value, input: Definition) -> Result<Value, Error> {
    if input.revision.is_some() {
        return Err(Error::Invalid("新建工作项无需修订号".into()));
    }
    if input.status.is_some() {
        return Err(Error::Invalid("新工作项固定为待开始，请勿指定状态".into()));
    }
    let id = Uuid::new_v4().to_string();
    let row = input.row(&id, 1, None)?;
    table_mut(db)?.insert(id, row.clone());
    Ok(row)
}
async fn replace(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(input): Json<Definition>,
) -> Result<Json<Value>, Error> {
    store.update(|db| {
        let old = find(db, &id)?;
        let revision = old["revision"].as_u64().ok_or_else(corrupt)?;
        if input.revision.is_some_and(|expected| expected != revision) {
            return Err(Error::Conflict("工作项已被修改，请刷新".into()));
        }
        let mut row = input.row(&id, revision, Some(old))?;
        if row != *old {
            row["revision"] = json!(revision.checked_add(1).ok_or_else(corrupt)?);
            table_mut(db)?.insert(id, row.clone());
        }
        Ok(Json(row))
    })
}
async fn remove(State(store): State<Store>, Path(id): Path<String>) -> Result<StatusCode, Error> {
    store.update(|db| {
        table_mut(db)?.remove(&id).ok_or_else(missing)?;
        projects::detach_item(db, &id)?;
        patches::detach_item(db, &id)?;
        Ok(StatusCode::NO_CONTENT)
    })
}
