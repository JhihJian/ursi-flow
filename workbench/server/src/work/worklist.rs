//! 工作清单管理可独立编辑的事项及生成工作包的配方。
mod convert;
mod generate;
mod runs;
#[cfg(test)]
mod tests;

use super::{Error, Store, catalog, patches, valid_label};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use uuid::Uuid;

const TABLE: &str = "workListItems";

pub(super) fn routes(store: Store, platform: ursi_mcp::McpPlatform) -> Router {
    let runs = runs::routes(store.clone(), platform.clone());
    Router::new()
        .route("/v2/work-items", get(list).post(create))
        .route(
            "/v2/work-items/{id}",
            get(detail).put(replace).delete(remove),
        )
        .with_state(store.clone())
        .merge(
            Router::new()
                .route("/v2/work-items/{id}/generate", post(generate::handle))
                .with_state((store, platform)),
        )
        .merge(runs)
}

pub(super) use runs::recover;

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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resource {
    alias: String,
    server_id: String,
    uri: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct GeneratorRef {
    id: String,
    revision: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    id: String,
    revision: u64,
    resources: Vec<Resource>,
}

fn resolve<'a>(
    db: &'a Value,
    id: &str,
    revision: u64,
    resources: &[Resource],
) -> Result<&'a Value, Error> {
    let generator = catalog::generator(db, id, revision)?;
    let aliases = generator["aliases"].as_array().ok_or_else(corrupt)?;
    let unique: HashSet<_> = resources.iter().map(|r| r.alias.as_str()).collect();
    if resources.len() != aliases.len()
        || unique.len() != aliases.len()
        || !aliases
            .iter()
            .all(|a| a.as_str().is_some_and(|s| unique.contains(s)))
        || resources
            .iter()
            .any(|r| !valid_label(&r.server_id, 128) || !valid_label(&r.uri, 4096))
    {
        return Err(Error::Invalid(
            "资源引用必须与生成器输入别名一一对应".into(),
        ));
    }
    Ok(generator)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Recipe {
    resources: Vec<Resource>,
    script: String,
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
    recipe: Option<Recipe>,
    generator: Option<Binding>,
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
        if let Some(recipe) = &self.recipe {
            if self.generator.is_some() {
                return Err(Error::Invalid("生成器与内嵌配方只能选择一种".into()));
            }
            if recipe.script.trim().is_empty() || recipe.resources.is_empty() {
                return Err(Error::Invalid("配方需要脚本和至少一个资源".into()));
            }
            let mut aliases = HashSet::new();
            for r in &recipe.resources {
                if [&r.alias, &r.server_id, &r.uri].into_iter().any(|s| {
                    s.trim().is_empty() || s.trim() != s || s.chars().any(char::is_control)
                }) {
                    return Err(Error::Invalid("资源别名、服务标识和 URI 必须有效".into()));
                }
                if !aliases.insert(&r.alias) {
                    return Err(Error::Invalid("配方资源别名重复".into()));
                }
            }
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
        let mut row = json!({"id":id,"title":title,"description":self.description,"category":category,"status":status,"recipe":self.recipe,"revision":revision});
        if let Some(binding) = &self.generator {
            row["generator"] = json!(binding);
        }
        Ok(row)
    }

    fn check_binding(&self, db: &Value) -> Result<(), Error> {
        if let Some(b) = &self.generator {
            resolve(db, &b.id, b.revision, &b.resources)?;
        }
        Ok(())
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
    if input.revision.is_some() {
        return Err(Error::Invalid("新建工作项无需修订号".into()));
    }
    if input.status.is_some() {
        return Err(Error::Invalid("新工作项固定为待开始，请勿指定状态".into()));
    }
    let id = Uuid::new_v4().to_string();
    let row = input.row(&id, 1, None)?;
    store.update(|db| {
        input.check_binding(db)?;
        table_mut(db)?.insert(id, row.clone());
        Ok(Json(row))
    })
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
        if &row != old {
            if row["generator"] != old["generator"] {
                input.check_binding(db)?;
            }
            row["revision"] = json!(revision.checked_add(1).ok_or_else(corrupt)?);
            table_mut(db)?.insert(id, row.clone());
        }
        Ok(Json(row))
    })
}
async fn remove(State(store): State<Store>, Path(id): Path<String>) -> Result<StatusCode, Error> {
    store.update(|db| {
        table_mut(db)?.remove(&id).ok_or_else(missing)?;
        patches::detach_item(db, &id)?;
        Ok(StatusCode::NO_CONTENT)
    })
}
