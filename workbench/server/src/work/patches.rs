//! 包只保存业务元信息与目录引用。文件接口由 directories 提供。
mod config;
#[cfg(test)]
mod tests;

use super::{Error, Store, directories, worklist};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    routing::get,
};
use config::{ConfigPackageRef, Kind};
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
    #[serde(rename = "configPackage", skip_serializing_if = "Option::is_none")]
    config_package: Option<ConfigPackageRef>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    work: Option<WorkMetadata>,
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

pub(super) fn routes(store: Store) -> Router {
    Router::new()
        .route("/v2/patches/{kind}", get(index).post(create))
        .route("/v2/patches/{kind}/{id}", get(detail).patch(set_owner))
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
    #[serde(rename = "configPackage", default)]
    config_package: Option<ConfigPackageRef>,
    #[serde(rename = "workItemId")]
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
    Path((key, id)): Path<(String, String)>,
    Json(input): Json<Owner>,
) -> Result<Json<Value>, Error> {
    if kind(&key)? != Kind::Work {
        return Err(Error::NotFound("只有工作包可设置工作项".into()));
    }
    store.update(|db| {
        if let Some(owner) = &input.work_item_id {
            worklist::find(db, owner)?;
        }
        let row = db[Kind::Work.table()]
            .get_mut(&id)
            .ok_or_else(|| Error::NotFound("工作包不存在".into()))?;
        row["workItemId"] = json!(input.work_item_id);
        Ok(Json(row.clone()))
    })
}

pub(super) fn detach_item(db: &mut Value, id: &str) -> Result<(), Error> {
    if let Some(table) = db.get_mut(Kind::Work.table()) {
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

fn register(db: &mut Value, kind: Kind, patch: Patch) -> Result<Value, Error> {
    let table = db
        .as_object_mut()
        .ok_or_else(corrupt)?
        .entry(kind.table())
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
        Kind::Work,
        Patch {
            id: Uuid::new_v4().to_string(),
            name,
            directory_id: directory_id.to_owned(),
            config_package: None,
            work: Some(WorkMetadata::new(
                "generated",
                Some(work_item_id.to_owned()),
                Some(provenance),
            )?),
        },
    )
}

async fn create(
    State(store): State<Store>,
    Path(key): Path<String>,
    Json(input): Json<Create>,
) -> Result<Json<Value>, Error> {
    let kind = kind(&key)?;
    if kind.is_config() && input.config_package.is_some() {
        return Err(Error::Invalid("配置包不能引用配置包".into()));
    }
    if kind.is_config() && input.work_item_id.is_some() {
        return Err(Error::Invalid("配置包不能关联工作清单项".into()));
    }
    let name = valid_name(&input.name)?;
    let config_package = input.config_package;
    tokio::task::spawn_blocking(move || {
        directories::allocate(
            &store,
            kind.rules(),
            |root| kind.seed(root),
            |db, directory_id| {
                if let Some(reference) = config_package.as_ref() {
                    config_package_directory(db, &reference.id)?;
                }
                if let Some(owner) = &input.work_item_id {
                    worklist::find(db, owner)?;
                }
                let row = Patch {
                    id: Uuid::new_v4().to_string(),
                    name,
                    directory_id: directory_id.to_owned(),
                    config_package,
                    work: if kind == Kind::Work {
                        Some(WorkMetadata::new("manual", input.work_item_id, None)?)
                    } else {
                        None
                    },
                };
                register(db, kind, row).map(Json)
            },
        )
    })
    .await
    .map_err(|_| Error::Internal("包创建任务中断".into()))?
}

pub(super) fn config_package_directory(db: &Value, package_id: &str) -> Result<String, Error> {
    let value = db
        .get(Kind::Config.table())
        .and_then(|packages| packages.get(package_id))
        .ok_or_else(|| Error::NotFound("配置包不存在".into()))?;
    if value["id"] != package_id {
        return Err(corrupt());
    }
    value["directoryId"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(corrupt)
}
