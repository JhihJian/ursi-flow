//! 配置包只保存元信息，文件和路径约束由目录模块管理。
#[cfg(test)]
mod tests;

use crate::work::{Error, Store, directories};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    routing::get,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

const TABLE: &str = "configPatches";

pub fn routes(store: Store) -> Router {
    Router::new()
        .route("/v2/patches/config", get(index).post(create))
        .route("/v2/patches/config/{id}", get(detail))
        .layer(DefaultBodyLimit::max(8192))
        .with_state(store)
}

fn corrupt() -> Error {
    Error::Internal("包记录损坏".into())
}

fn find<'a>(db: &'a Value, id: &str) -> Result<&'a Value, Error> {
    db[TABLE]
        .get(id)
        .ok_or_else(|| Error::NotFound("配置包不存在".into()))
}

pub(super) fn config_package_directory(db: &Value, id: &str) -> Result<String, Error> {
    let row = find(db, id)?;
    if row["id"] != id {
        return Err(corrupt());
    }
    row["directoryId"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(corrupt)
}

async fn index(State(store): State<Store>) -> Result<Json<Vec<Value>>, Error> {
    store.read(|db| match db.get(TABLE) {
        None => Ok(Json(Vec::new())),
        Some(rows) => Ok(Json(
            rows.as_object()
                .ok_or_else(corrupt)?
                .values()
                .cloned()
                .collect(),
        )),
    })
}

async fn detail(State(store): State<Store>, Path(id): Path<String>) -> Result<Json<Value>, Error> {
    store.read(|db| Ok(Json(find(db, &id)?.clone())))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigPackageRef {
    #[serde(rename = "id")]
    _id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    name: String,
    config_package: Option<ConfigPackageRef>,
    work_item_id: Option<String>,
}

async fn create(
    State(store): State<Store>,
    Json(input): Json<Create>,
) -> Result<Json<Value>, Error> {
    if input.config_package.is_some() {
        return Err(Error::Invalid("配置包不能引用配置包".into()));
    }
    if input.work_item_id.is_some() {
        return Err(Error::Invalid("配置包不能关联工作清单项".into()));
    }
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "包名需为 1 至 80 个字符，且不含控制字符".into(),
        ));
    }
    let name = name.to_owned();
    tokio::task::spawn_blocking(move || {
        directories::allocate(
            &store,
            directories::Rules {
                fixed: ["AGENTS.md", "skills", "mcp.json"]
                    .map(String::from)
                    .to_vec(),
                json_objects: vec!["mcp.json".into()],
            },
            |root| {
                use directories::fs;
                fs::write(root, &["AGENTS.md".into()], b"", false)?;
                fs::mkdir(root, &["skills".into()])?;
                fs::write(root, &["mcp.json".into()], br#"{"mcpServers":{}}"#, false)?;
                Ok(())
            },
            |db, directory_id| {
                let rows = db
                    .as_object_mut()
                    .ok_or_else(corrupt)?
                    .entry(TABLE)
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .ok_or_else(corrupt)?;
                let id = Uuid::new_v4().to_string();
                let row = json!({"id": id, "name": name, "directoryId": directory_id});
                rows.insert(id, row.clone());
                Ok(Json(row))
            },
        )
    })
    .await
    .map_err(|_| Error::Internal("包创建任务中断".into()))?
}
