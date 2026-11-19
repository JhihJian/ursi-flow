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
    #[serde(rename = "configPackage", default)]
    config_package: Option<ConfigPackageRef>,
}

async fn create(
    State(store): State<Store>,
    Path(key): Path<String>,
    Json(input): Json<Create>,
) -> Result<Json<Patch>, Error> {
    let kind = kind(&key)?;
    if kind.is_config() && input.config_package.is_some() {
        return Err(Error::Invalid("配置包不能引用配置包".into()));
    }
    let name = input.name.trim().to_owned();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "包名需为 1 至 80 个字符，且不含控制字符".into(),
        ));
    }
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
                let row = Patch {
                    id: Uuid::new_v4().to_string(),
                    name,
                    directory_id: directory_id.to_owned(),
                    config_package,
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

const CONFIG_SNAPSHOTS: &str = "configPackageSnapshots";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConfigPackageSnapshot {
    pub(super) source_package_id: String,
    pub(super) content_digest: String,
    pub(super) snapshot_directory_id: String,
}

fn config_package_directory(db: &Value, package_id: &str) -> Result<String, Error> {
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

fn existing_snapshot(db: &Value, attempt_id: &str) -> Result<Option<ConfigPackageSnapshot>, Error> {
    let Some(value) = db
        .get(CONFIG_SNAPSHOTS)
        .and_then(|snapshots| snapshots.get(attempt_id))
    else {
        return Ok(None);
    };
    serde_json::from_value(value.clone())
        .map(Some)
        .map_err(|_| corrupt())
}

/// 为一次尝试建立独立、已冻结的配置包目录，并持久化快照元信息。
///
/// execute 只应把返回的 `snapshot_directory_id` 作为目录能力引用交给执行器，不能调用
/// `directories::path` 后自行使用源包目录。`attempt_id` 在一次尝试内只允许成功快照一次。
pub(super) fn snapshot_config_package(
    store: &Store,
    attempt_id: &str,
    package_id: &str,
) -> Result<ConfigPackageSnapshot, Error> {
    if attempt_id.trim().is_empty() {
        return Err(Error::Invalid("尝试标识不能为空".into()));
    }
    if let Some(existing) = store.read(|db| existing_snapshot(db, attempt_id))? {
        if existing.source_package_id == package_id {
            return Ok(existing);
        }
        return Err(Error::Conflict("尝试已绑定其他配置包".into()));
    }
    let source_directory = store.read(|db| config_package_directory(db, package_id))?;
    directories::validate_rules(store, &source_directory, Kind::Config.rules())?;
    directories::snapshot(
        store,
        &source_directory,
        Kind::Config.rules(),
        |db, snapshot| {
            let result = ConfigPackageSnapshot {
                source_package_id: package_id.to_owned(),
                content_digest: snapshot.content_digest,
                snapshot_directory_id: snapshot.directory_id,
            };
            let table = db
                .as_object_mut()
                .ok_or_else(corrupt)?
                .entry(CONFIG_SNAPSHOTS)
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(corrupt)?;
            if table.contains_key(attempt_id) {
                return Err(Error::Conflict("尝试已建立配置包快照".into()));
            }
            table.insert(attempt_id.to_owned(), json!(&result));
            Ok(result)
        },
    )
}
