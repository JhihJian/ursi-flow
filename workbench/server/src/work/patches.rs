//! 工作包与配置包：每个包在 Server 私有目录中有独立根，按包根相对路径管理文件。
//!
//! 本模块负责路由、包记录和写锁；目录操作归 [dir]，哪些路径对某一类包有额外含义
//! 归 [config]。包内容只经本模块读写，不接入执行、SOP 或版本。
mod config;
mod dir;
#[cfg(test)]
mod tests;

use super::{Error, Store};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::Response,
    routing::{delete, get, post},
};
use config::Kind;
use dir::Fault;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    fs::{self, DirBuilder},
    io,
    os::unix::fs::DirBuilderExt,
    path::{Path as FsPath, PathBuf},
};
use uuid::Uuid;

/// JSON 请求体只承载名称和包内路径。
const JSON_LIMIT: usize = 8 * 1024;
const NAME_MAX: usize = 80;
const RECORDS: &str = "patches";

#[derive(Serialize)]
struct Patch {
    id: String,
    name: String,
}

impl From<Fault> for Error {
    fn from(fault: Fault) -> Self {
        match fault {
            Fault::Invalid(m) => Self::Invalid(m),
            Fault::NotFound(m) => Self::NotFound(m),
            Fault::Conflict(m) => Self::Conflict(m),
            Fault::Internal(m) => Self::Internal(m),
        }
    }
}

pub(super) fn routes(store: Store) -> io::Result<Router> {
    dir::prepare(store.dir())?;
    Ok(Router::new()
        .route("/v2/patches/{kind}", get(index).post(create))
        .route("/v2/patches/{kind}/{id}/tree", get(tree))
        .route("/v2/patches/{kind}/{id}/dir", post(mkdir))
        .route("/v2/patches/{kind}/{id}/move", post(relocate))
        .route("/v2/patches/{kind}/{id}/entry", delete(remove))
        .layer(DefaultBodyLimit::max(JSON_LIMIT))
        .route(
            "/v2/patches/{kind}/{id}/file",
            get(read)
                .put(write)
                .layer(DefaultBodyLimit::max(dir::FILE_LIMIT as usize + 1)),
        )
        .with_state(store))
}

fn kind(value: &str) -> Result<Kind, Error> {
    Kind::parse(value).ok_or_else(|| Error::NotFound("包类型不存在".into()))
}

fn corrupt() -> Error {
    Error::Internal("包记录损坏".into())
}

fn patch(value: &Value) -> Option<Patch> {
    Some(Patch {
        id: value.get("id")?.as_str()?.to_owned(),
        name: value.get("name")?.as_str()?.to_owned(),
    })
}

fn packages(db: &Value, kind: Kind) -> Option<&Map<String, Value>> {
    db.get(RECORDS)
        .and_then(|all| all.get(kind.key()))
        .and_then(Value::as_object)
}

fn find(db: &Value, kind: Kind, id: &str) -> Result<Patch, Error> {
    packages(db, kind)
        .and_then(|all| all.get(id))
        .and_then(patch)
        .ok_or_else(|| Error::NotFound("包不存在".into()))
}

fn packages_mut(db: &mut Value, kind: Kind) -> Result<&mut Map<String, Value>, Error> {
    let root = db.as_object_mut().ok_or_else(corrupt)?;
    let all = root.entry(RECORDS).or_insert_with(|| json!({}));
    let typed = all
        .as_object_mut()
        .ok_or_else(corrupt)?
        .entry(kind.key())
        .or_insert_with(|| json!({}));
    typed.as_object_mut().ok_or_else(corrupt)
}

/// 已登记包在磁盘上的私有根。记录先于磁盘操作存在，路径只用服务端生成的标识拼装。
fn private_root(store: &Store, kind: Kind, id: &str) -> Result<PathBuf, Error> {
    store.read(|db| find(db, kind, id))?;
    Ok(kind_root(store, kind)?.join(id))
}

fn kind_root(store: &Store, kind: Kind) -> Result<PathBuf, Error> {
    let base = dir::verify(&store.dir().join(dir::PACKAGES))?;
    Ok(dir::verify(&base.join(kind.key()))?)
}

fn patch_name(value: &str) -> Result<String, Error> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > NAME_MAX || name.chars().any(char::is_control) {
        return Err(Error::Invalid(format!(
            "包名需为 1 至 {NAME_MAX} 个字符的名称，且不含控制字符"
        )));
    }
    Ok(name.to_owned())
}

async fn index(State(store): State<Store>, Path(key): Path<String>) -> Result<Json<Value>, Error> {
    let kind = kind(&key)?;
    store
        .read(|db| {
            let list: Vec<Patch> = packages(db, kind)
                .map(|all| all.values().filter_map(patch).collect())
                .unwrap_or_default();
            Ok(json!(list))
        })
        .map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    name: String,
}

async fn create(
    State(store): State<Store>,
    Path(key): Path<String>,
    Json(body): Json<Create>,
) -> Result<Json<Patch>, Error> {
    let kind = kind(&key)?;
    let name = patch_name(&body.name)?;
    let id = Uuid::new_v4().to_string();
    let root = kind_root(&store, kind)?.join(&id);
    let patch = tokio::task::spawn_blocking(move || {
        DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .map_err(|_| Error::Internal("包目录创建失败".into()))?;
        let result = allocate(&store, kind, &root, &id, &name);
        if result.is_err() {
            // 记录没有建立时，磁盘上的半成品包不能留下。
            let _ = fs::remove_dir_all(&root);
        }
        result
    })
    .await
    .map_err(|_| Error::Internal("包创建任务中断".into()))??;
    Ok(Json(patch))
}

/// 先建目录并写入初始内容，再登记记录。任一步失败都由调用方清理目录。
fn allocate(
    store: &Store,
    kind: Kind,
    root: &FsPath,
    id: &str,
    name: &str,
) -> Result<Patch, Error> {
    dir::verify(root)?;
    kind.seed(root)?;
    store.update(|db| {
        packages_mut(db, kind)?.insert(id.to_owned(), json!({"id":id,"name":name}));
        Ok(())
    })?;
    Ok(Patch {
        id: id.to_owned(),
        name: name.to_owned(),
    })
}

async fn tree(
    State(store): State<Store>,
    Path((key, id)): Path<(String, String)>,
) -> Result<Json<Value>, Error> {
    let kind = kind(&key)?;
    let root = private_root(&store, kind, &id)?;
    let entries = tokio::task::spawn_blocking(move || store.read(|_| Ok(dir::tree(&root)?)))
        .await
        .map_err(|_| Error::Internal("包目录读取任务中断".into()))??;
    Ok(Json(json!(entries)))
}

#[derive(Deserialize)]
struct FileQuery {
    path: String,
    #[serde(default)]
    replace: Option<bool>,
}

async fn read(
    State(store): State<Store>,
    Path((key, id)): Path<(String, String)>,
    Query(query): Query<FileQuery>,
) -> Result<Response, Error> {
    let kind = kind(&key)?;
    let parts = dir::segments(&query.path, false)?;
    let root = private_root(&store, kind, &id)?;
    let bytes = tokio::task::spawn_blocking(move || store.read(|_| Ok(dir::read(&root, &parts)?)))
        .await
        .map_err(|_| Error::Internal("包文件读取任务中断".into()))??;
    let mut response = Response::new(axum::body::Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn write(
    State(store): State<Store>,
    Path((key, id)): Path<(String, String)>,
    Query(query): Query<FileQuery>,
    body: Bytes,
) -> Result<StatusCode, Error> {
    let kind = kind(&key)?;
    let parts = dir::segments(&query.path, false)?;
    // 类别校验先于写锁，坏正文不进入临界区。
    kind.check_write(&query.path, &body)?;
    let root = private_root(&store, kind, &id)?;
    let replace = query.replace.unwrap_or(false);
    let bytes = body.to_vec();
    tokio::task::spawn_blocking(move || {
        store.read(|_| Ok(dir::write(&root, &parts, &bytes, replace)?))
    })
    .await
    .map_err(|_| Error::Internal("包文件写入任务中断".into()))??;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Mkdir {
    path: String,
}

async fn mkdir(
    State(store): State<Store>,
    Path((key, id)): Path<(String, String)>,
    Json(body): Json<Mkdir>,
) -> Result<StatusCode, Error> {
    let kind = kind(&key)?;
    let parts = dir::segments(&body.path, false)?;
    let root = private_root(&store, kind, &id)?;
    tokio::task::spawn_blocking(move || store.read(|_| Ok(dir::mkdir(&root, &parts)?)))
        .await
        .map_err(|_| Error::Internal("包目录创建任务中断".into()))??;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Move {
    from: String,
    to: String,
}

async fn relocate(
    State(store): State<Store>,
    Path((key, id)): Path<(String, String)>,
    Json(body): Json<Move>,
) -> Result<StatusCode, Error> {
    let kind = kind(&key)?;
    let from = dir::segments(&body.from, false)?;
    let to = dir::segments(&body.to, false)?;
    kind.check_move(&body.from, &body.to)?;
    let root = private_root(&store, kind, &id)?;
    tokio::task::spawn_blocking(move || store.read(|_| Ok(dir::relocate(&root, &from, &to)?)))
        .await
        .map_err(|_| Error::Internal("包内移动任务中断".into()))??;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct EntryQuery {
    path: String,
}

async fn remove(
    State(store): State<Store>,
    Path((key, id)): Path<(String, String)>,
    Query(query): Query<EntryQuery>,
) -> Result<StatusCode, Error> {
    let kind = kind(&key)?;
    let parts = dir::segments(&query.path, false)?;
    kind.check_remove(&query.path)?;
    let root = private_root(&store, kind, &id)?;
    tokio::task::spawn_blocking(move || store.read(|_| Ok(dir::remove(&root, &parts)?)))
        .await
        .map_err(|_| Error::Internal("包内删除任务中断".into()))??;
    Ok(StatusCode::NO_CONTENT)
}
