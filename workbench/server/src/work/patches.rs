//! 包只保存业务元信息与目录引用。文件接口由 directories 提供。
mod config;
#[cfg(test)]
mod tests;

use super::{Error, Store, directories};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    routing::get,
};
use config::Kind;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Patch {
    id: String,
    name: String,
    directory_id: String,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    work: Option<WorkMetadata>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkMetadata {
    source: &'static str,
    created_at: u64,
    execution_status: &'static str,
}

pub(super) fn routes(store: Store) -> Router {
    Router::new()
        .route("/v2/patches/{kind}", get(index).post(create))
        .route("/v2/patches/{kind}/{id}", get(detail))
        .layer(DefaultBodyLimit::max(8192))
        .with_state(store)
}

fn kind(value: &str) -> Result<Kind, Error> {
    Kind::parse(value).ok_or_else(|| Error::NotFound("包类型不存在".into()))
}

async fn index(State(store): State<Store>, Path(key): Path<String>) -> Result<Json<Value>, Error> {
    let table = kind(&key)?.table();
    store.read(|db| match db.get(table) {
        None => Ok(Json(json!([]))),
        Some(rows) => Ok(Json(json!(
            rows.as_object()
                .ok_or_else(corrupt)?
                .values()
                .collect::<Vec<_>>()
        ))),
    })
}

fn corrupt() -> Error {
    Error::Internal("包记录损坏".into())
}

async fn detail(
    State(store): State<Store>,
    Path((key, id)): Path<(String, String)>,
) -> Result<Json<Value>, Error> {
    let table = kind(&key)?.table();
    store.read(|db| {
        db[table]
            .get(id)
            .cloned()
            .map(Json)
            .ok_or_else(|| Error::NotFound("包不存在".into()))
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    name: String,
}

async fn create(
    State(store): State<Store>,
    Path(key): Path<String>,
    Json(input): Json<Create>,
) -> Result<Json<Patch>, Error> {
    let kind = kind(&key)?;
    let name = input.name.trim().to_owned();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "包名需为 1 至 80 个字符，且不含控制字符".into(),
        ));
    }
    tokio::task::spawn_blocking(move || {
        directories::allocate(
            &store,
            kind.rules(),
            |root| kind.seed(root),
            |db, directory_id| {
                let row = Patch {
                    id: Uuid::new_v4().to_string(),
                    name,
                    directory_id: directory_id.to_owned(),
                    work: if kind == Kind::Work {
                        Some(WorkMetadata {
                            source: "manual",
                            created_at: SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .map_err(|_| Error::Internal("系统时间无效".into()))?
                                .as_secs(),
                            execution_status: "not_started",
                        })
                    } else {
                        None
                    },
                };
                let table = db
                    .as_object_mut()
                    .ok_or_else(corrupt)?
                    .entry(kind.table())
                    .or_insert_with(|| json!({}));
                table
                    .as_object_mut()
                    .ok_or_else(corrupt)?
                    .insert(row.id.clone(), json!(row));
                Ok(Json(row))
            },
        )
    })
    .await
    .map_err(|_| Error::Internal("包创建任务中断".into()))?
}
