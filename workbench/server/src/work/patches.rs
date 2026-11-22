//! 工作包保存业务元信息与目录引用。文件接口由 directories 提供。
#[cfg(test)]
mod tests;

use super::{Error, Store, directories, platform_proxy::Platform, worklist};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const TABLE: &str = "workPatches";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Patch {
    id: String,
    name: String,
    directory_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    config_package: Option<ConfigPackageRef>,
    #[serde(flatten)]
    work: WorkMetadata,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkMetadata {
    source: &'static str,
    created_at: u64,
    execution_status: &'static str,
    work_item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provenance: Option<Value>,
}

impl WorkMetadata {
    fn new(
        source: &'static str,
        work_item_id: Option<String>,
        provenance: Option<Value>,
    ) -> Result<Self, Error> {
        Ok(Self {
            source,
            work_item_id,
            provenance,
            execution_status: "not_started",
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| Error::Internal("系统时间无效".into()))?
                .as_secs(),
        })
    }
}

pub(super) fn routes_with_platform(store: Store, platform: Option<Platform>) -> Router {
    Router::new()
        .route(
            "/v2/patches/work",
            get(index).post(move |state, body| create(state, body, platform)),
        )
        .route("/v2/patches/work/{id}", get(detail).patch(set_owner))
        .layer(DefaultBodyLimit::max(8192))
        .with_state(store)
}

async fn index(State(store): State<Store>) -> Result<Json<Value>, Error> {
    store.read(|db| match db.get(TABLE) {
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

async fn detail(State(store): State<Store>, Path(id): Path<String>) -> Result<Json<Value>, Error> {
    store.read(|db| {
        db[TABLE]
            .get(id)
            .cloned()
            .map(Json)
            .ok_or_else(|| Error::NotFound("包不存在".into()))
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ConfigPackageRef {
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Create {
    name: String,
    config_package: Option<ConfigPackageRef>,
    work_item_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Owner {
    // 缺少字段是坏请求；显式 null 才表示解绑。
    #[serde(deserialize_with = "Option::<String>::deserialize")]
    work_item_id: Option<String>,
}

async fn set_owner(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(input): Json<Owner>,
) -> Result<Json<Value>, Error> {
    store.update(|db| {
        if let Some(owner) = &input.work_item_id {
            worklist::find(db, owner)?;
        }
        let row = db[TABLE]
            .get_mut(&id)
            .ok_or_else(|| Error::NotFound("工作包不存在".into()))?;
        row["workItemId"] = json!(input.work_item_id);
        Ok(Json(row.clone()))
    })
}

pub(super) fn detach_item(db: &mut Value, id: &str) -> Result<(), Error> {
    if let Some(table) = db.get_mut(TABLE) {
        for patch in table.as_object_mut().ok_or_else(corrupt)?.values_mut() {
            if patch["workItemId"] == id {
                patch["workItemId"] = Value::Null;
            }
        }
    }
    Ok(())
}

pub(super) fn valid_name(name: &str) -> Result<String, Error> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "包名需为 1 至 80 个字符，且不含控制字符".into(),
        ));
    }
    Ok(name.to_owned())
}

fn register(db: &mut Value, patch: Patch) -> Result<Value, Error> {
    let table = db
        .as_object_mut()
        .ok_or_else(corrupt)?
        .entry(TABLE)
        .or_insert_with(|| json!({}));
    let row = json!(&patch);
    table
        .as_object_mut()
        .ok_or_else(corrupt)?
        .insert(patch.id, row.clone());
    Ok(row)
}

pub(super) fn register_generated(
    db: &mut Value,
    name: String,
    directory_id: &str,
    work_item_id: &str,
    provenance: Value,
) -> Result<Value, Error> {
    register(
        db,
        Patch {
            id: Uuid::new_v4().to_string(),
            name,
            directory_id: directory_id.to_owned(),
            config_package: None,
            work: WorkMetadata::new("generated", Some(work_item_id.to_owned()), Some(provenance))?,
        },
    )
}

async fn create(
    State(store): State<Store>,
    Json(input): Json<Create>,
    platform: Option<Platform>,
) -> Result<Json<Value>, Error> {
    let name = valid_name(&input.name)?;
    if let Some(reference) = &input.config_package {
        if Uuid::parse_str(&reference.id).is_err() {
            return Err(Error::Invalid("配置包标识无效".into()));
        }
        platform
            .ok_or_else(|| Error::Unavailable("无法验证平台配置包引用".into()))?
            .check_config(&reference.id)
            .await?;
    }
    tokio::task::spawn_blocking(move || {
        directories::allocate(
            &store,
            directories::Rules::default(),
            |_| Ok(()),
            |db, directory_id| {
                if let Some(owner) = &input.work_item_id {
                    worklist::find(db, owner)?;
                }
                let row = Patch {
                    id: Uuid::new_v4().to_string(),
                    name,
                    directory_id: directory_id.to_owned(),
                    config_package: input.config_package,
                    work: WorkMetadata::new("manual", input.work_item_id, None)?,
                };
                register(db, row).map(Json)
            },
        )
    })
    .await
    .map_err(|_| Error::Internal("包创建任务中断".into()))?
}
