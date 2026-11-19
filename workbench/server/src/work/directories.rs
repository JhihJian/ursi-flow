//! 虚拟目录资源：每个目录是 Server 私有根下的一棵文件树，用服务端生成的标识寻址。
//!
//! 本模块负责路由、目录记录和写锁；文件树操作归 [fs]，路径约束归 [Rules]。
//! 上层资源通过 [allocate] 建立目录，并在同一笔存储更新中登记自己的记录。
pub(super) mod fs;
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
use fs::Fault;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    fs as host_fs, io,
    path::{Path as FsPath, PathBuf},
};
use uuid::Uuid;

/// JSON 请求体只承载目录内路径。
const JSON_LIMIT: usize = 8 * 1024;
const RECORDS: &str = "directories";

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

/// 目录的路径约束：固定位置不能移动或删除，指定文件必须是 JSON 对象。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Rules {
    #[serde(default)]
    pub(super) fixed: Vec<String>,
    #[serde(default)]
    pub(super) json_objects: Vec<String>,
}

impl Rules {
    /// 统一成名称段用 `/` 连接的形式，后续比较只看规范路径。
    fn normalized(self) -> Result<Self, Error> {
        Ok(Self {
            fixed: normalize(self.fixed)?,
            json_objects: normalize(self.json_objects)?,
        })
    }

    fn check_write(&self, path: &str, bytes: &[u8]) -> Result<(), Error> {
        // 用文件占用固定位置或受约束文件的上级目录，会让受保护的路径不可达。
        if self.reserves(path) {
            return Err(Error::Conflict("不能占用固定路径或其上级目录".into()));
        }
        if self.requires_json(path) {
            let value: Value = serde_json::from_slice(bytes)
                .map_err(|_| Error::Invalid("该文件必须是合法的 JSON".into()))?;
            if !value.is_object() {
                return Err(Error::Invalid("该文件顶层必须是 JSON 对象".into()));
            }
        }
        Ok(())
    }

    fn check_move(&self, from: &str, to: &str) -> Result<(), Error> {
        if self.shelters(from) || self.shelters(to) {
            return Err(Error::Conflict(
                "固定路径及其上级目录不能移动或被占用".into(),
            ));
        }
        Ok(())
    }

    fn check_remove(&self, path: &str) -> Result<(), Error> {
        if self.shelters(path) {
            return Err(Error::Conflict("固定路径及其上级目录不能删除".into()));
        }
        Ok(())
    }

    fn requires_json(&self, path: &str) -> bool {
        self.json_objects.iter().any(|object| object == path)
    }

    fn reserves(&self, path: &str) -> bool {
        self.fixed
            .iter()
            .chain(&self.json_objects)
            .any(|guarded| under(path, guarded))
    }

    /// 路径本身是固定位置，或移动、删除它会带走固定位置。
    fn shelters(&self, path: &str) -> bool {
        self.fixed
            .iter()
            .any(|fixed| fixed == path || under(path, fixed))
    }
}

fn normalize(paths: Vec<String>) -> Result<Vec<String>, Error> {
    paths
        .into_iter()
        .map(|path| Ok(fs::segments(&path, false)?.join("/")))
        .collect()
}

fn under(parent: &str, child: &str) -> bool {
    child.len() > parent.len()
        && child.starts_with(parent)
        && child.as_bytes()[parent.len()] == b'/'
}

/// 目录的可写性。执行结束后，制品目录冻结为只读，禁止写入、移动和删除。
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    #[default]
    Writable,
    Frozen,
}

#[derive(Clone, Deserialize, Serialize)]
struct Record {
    id: String,
    #[serde(default)]
    rules: Rules,
    #[serde(default)]
    state: Mode,
}

impl Record {
    fn writable(&self) -> Result<(), Error> {
        (self.state == Mode::Writable)
            .then_some(())
            .ok_or_else(|| Error::Conflict("目录已冻结，不能写入、移动或删除".into()))
    }
}

pub(super) fn routes(store: Store) -> io::Result<Router> {
    fs::prepare(store.dir())?;
    Ok(Router::new()
        .route("/v2/directories", get(index).post(create))
        .route("/v2/directories/{id}", get(detail))
        .route("/v2/directories/{id}/tree", get(tree))
        .route("/v2/directories/{id}/dir", post(mkdir))
        .route("/v2/directories/{id}/move", post(relocate))
        .route("/v2/directories/{id}/entry", delete(remove))
        .layer(DefaultBodyLimit::max(JSON_LIMIT))
        .route(
            "/v2/directories/{id}/file",
            get(read)
                .put(write)
                .layer(DefaultBodyLimit::max(fs::FILE_LIMIT as usize + 1)),
        )
        .with_state(store))
}

fn corrupt() -> Error {
    Error::Internal("目录记录损坏".into())
}

fn directories(db: &Value) -> Option<&Map<String, Value>> {
    db.get(RECORDS).and_then(Value::as_object)
}

fn find(db: &Value, id: &str) -> Result<Record, Error> {
    let value = directories(db)
        .and_then(|all| all.get(id))
        .ok_or_else(|| Error::NotFound("目录不存在".into()))?;
    let record: Record = serde_json::from_value(value.clone()).map_err(|_| corrupt())?;
    if record.id != id {
        return Err(corrupt());
    }
    Ok(record)
}

fn records_mut(db: &mut Value) -> Result<&mut Map<String, Value>, Error> {
    db.as_object_mut()
        .ok_or_else(corrupt)?
        .entry(RECORDS)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(corrupt)
}

/// 目录根在磁盘上的位置，只用服务端生成的标识拼装。
fn base(store: &Store) -> Result<PathBuf, Error> {
    Ok(fs::root(store.dir())?)
}

fn prepare(store: &Store) -> Result<PathBuf, Error> {
    fs::prepare(store.dir()).map_err(|e| Error::Internal(format!("目录根不可用：{e}")))?;
    base(store)
}

/// 已登记目录及其私有根。记录先于磁盘操作存在。
fn located(store: &Store, id: &str) -> Result<(Record, PathBuf), Error> {
    let record = store.read(|db| find(db, id))?;
    Ok((record, base(store)?.join(id)))
}

/// 目录根在磁盘上的位置，只用服务端生成的标识拼装。调用方不会把它返回给浏览器。
pub(super) fn path(store: &Store, id: &str) -> Result<PathBuf, Error> {
    Ok(base(store)?.join(id))
}

/// 冻结目录记录：只改元信息，不触碰磁盘内容。可与尝试记录在同一笔更新中完成。
pub(super) fn freeze(db: &mut Value, id: &str) -> Result<(), Error> {
    let record = records_mut(db)?
        .get_mut(id)
        .ok_or_else(|| Error::NotFound("目录不存在".into()))?;
    if record["id"] != id {
        return Err(corrupt());
    }
    record["state"] = json!(Mode::Frozen);
    Ok(())
}

/// 先建目录并执行 seed，再在同一笔更新中登记目录元信息和调用方记录。
/// 任一步失败都会删除磁盘目录，不留下未登记的半成品。
pub(super) fn allocate<T>(
    store: &Store,
    rules: Rules,
    seed: impl FnOnce(&FsPath) -> Result<(), Error>,
    register: impl FnOnce(&mut Value, &str) -> Result<T, Error>,
) -> Result<T, Error> {
    let rules = rules.normalized()?;
    let id = Uuid::new_v4().to_string();
    let root = prepare(store)?.join(&id);
    fs::create(&root).map_err(|e| Error::Internal(format!("目录创建失败：{e}")))?;
    let result = (|| {
        fs::verify(&root)?;
        seed(&root)?;
        let record = json!({"id": id, "rules": rules, "state": Mode::Writable});
        store.update(|db| {
            records_mut(db)?.insert(id.clone(), record);
            register(db, &id)
        })
    })();
    if result.is_err() {
        let _ = host_fs::remove_dir_all(&root);
    }
    result
}

async fn index(State(store): State<Store>) -> Result<Json<Value>, Error> {
    store
        .read(|db| {
            let list: Vec<Value> = directories(db)
                .map(|all| {
                    all.values()
                        .map(|value| {
                            let record: Record =
                                serde_json::from_value(value.clone()).map_err(|_| corrupt())?;
                            Ok(json!({"id": record.id}))
                        })
                        .collect::<Result<_, Error>>()
                })
                .transpose()?
                .unwrap_or_default();
            Ok(json!(list))
        })
        .map(Json)
}

async fn create(State(store): State<Store>, Json(body): Json<Value>) -> Result<Json<Value>, Error> {
    if !body.as_object().is_some_and(|fields| fields.is_empty()) {
        return Err(Error::Invalid("创建目录只接受空 JSON 对象".into()));
    }
    let id = tokio::task::spawn_blocking(move || {
        allocate(
            &store,
            Rules::default(),
            |_| Ok(()),
            |_, id| Ok(id.to_owned()),
        )
    })
    .await
    .map_err(|_| Error::Internal("目录创建任务中断".into()))??;
    Ok(Json(json!({"id": id})))
}

async fn detail(State(store): State<Store>, Path(id): Path<String>) -> Result<Json<Value>, Error> {
    let record = store.read(|db| find(db, &id))?;
    Ok(Json(json!({"id": record.id})))
}

async fn tree(State(store): State<Store>, Path(id): Path<String>) -> Result<Json<Value>, Error> {
    let (_, root) = located(&store, &id)?;
    let entries = tokio::task::spawn_blocking(move || store.read(|_| Ok(fs::tree(&root)?)))
        .await
        .map_err(|_| Error::Internal("目录读取任务中断".into()))??;
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
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<Response, Error> {
    let parts = fs::segments(&query.path, false)?;
    let (_, root) = located(&store, &id)?;
    let bytes = tokio::task::spawn_blocking(move || store.read(|_| Ok(fs::read(&root, &parts)?)))
        .await
        .map_err(|_| Error::Internal("目录文件读取任务中断".into()))??;
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
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
    body: Bytes,
) -> Result<StatusCode, Error> {
    let parts = fs::segments(&query.path, false)?;
    let (record, root) = located(&store, &id)?;
    record.writable()?;
    // 约束校验先于写锁，坏正文不进入临界区。
    record.rules.check_write(&query.path, &body)?;
    let replace = query.replace.unwrap_or(false);
    let bytes = body.to_vec();
    tokio::task::spawn_blocking(move || {
        store.read(|_| Ok(fs::write(&root, &parts, &bytes, replace)?))
    })
    .await
    .map_err(|_| Error::Internal("目录文件写入任务中断".into()))??;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Mkdir {
    path: String,
}

async fn mkdir(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(body): Json<Mkdir>,
) -> Result<StatusCode, Error> {
    let parts = fs::segments(&body.path, false)?;
    let (record, root) = located(&store, &id)?;
    record.writable()?;
    tokio::task::spawn_blocking(move || store.read(|_| Ok(fs::mkdir(&root, &parts)?)))
        .await
        .map_err(|_| Error::Internal("目录创建任务中断".into()))??;
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
    Path(id): Path<String>,
    Json(body): Json<Move>,
) -> Result<StatusCode, Error> {
    let from = fs::segments(&body.from, false)?;
    let to = fs::segments(&body.to, false)?;
    let (record, root) = located(&store, &id)?;
    record.writable()?;
    record.rules.check_move(&body.from, &body.to)?;
    let rules = record.rules;
    let target = body.to.clone();
    tokio::task::spawn_blocking(move || {
        store.read(|_| {
            // 移动到受 JSON 约束的路径不能绕过正文校验。
            if rules.requires_json(&target) {
                let bytes = fs::read(&root, &from)?;
                rules.check_write(&target, &bytes)?;
            }
            Ok(fs::relocate(&root, &from, &to)?)
        })
    })
    .await
    .map_err(|_| Error::Internal("目录内移动任务中断".into()))??;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct EntryQuery {
    path: String,
}

async fn remove(
    State(store): State<Store>,
    Path(id): Path<String>,
    Query(query): Query<EntryQuery>,
) -> Result<StatusCode, Error> {
    let parts = fs::segments(&query.path, false)?;
    let (record, root) = located(&store, &id)?;
    record.writable()?;
    record.rules.check_remove(&query.path)?;
    tokio::task::spawn_blocking(move || store.read(|_| Ok(fs::remove(&root, &parts)?)))
        .await
        .map_err(|_| Error::Internal("目录内删除任务中断".into()))??;
    Ok(StatusCode::NO_CONTENT)
}
