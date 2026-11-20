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
    cell::RefCell,
    fs as host_fs,
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path as FsPath, PathBuf},
    rc::Rc,
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
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
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

fn valid_id(id: &str) -> Result<(), Error> {
    fs::segments(id, false)
        .map(|_| ())
        .map_err(|_| Error::NotFound("目录不存在".into()))
}

fn prepare(store: &Store) -> Result<PathBuf, Error> {
    fs::prepare(store.dir()).map_err(|e| Error::Internal(format!("目录根不可用：{e}")))?;
    base(store)
}

/// 已登记目录及其私有根。记录先于磁盘操作存在。
fn located(store: &Store, id: &str) -> Result<(Record, PathBuf), Error> {
    let record = store.read(|db| find(db, id))?;
    Ok((record, path(store, id)?))
}

/// 目录根在磁盘上的位置，只用服务端生成的标识拼装。调用方不会把它返回给浏览器。
pub(super) fn path(store: &Store, id: &str) -> Result<PathBuf, Error> {
    valid_id(id)?;
    store.read(|db| find(db, id).map(|_| ()))?;
    Ok(base(store)?.join(id))
}

/// 校验上层资源引用的目录仍是已登记且满足预期约束的目录。
pub(super) fn validate_rules(store: &Store, id: &str, expected: Rules) -> Result<(), Error> {
    let record = store.read(|db| find(db, id))?;
    if record.rules != expected.normalized()? {
        return Err(Error::Conflict("目录约束与配置包不匹配".into()));
    }
    Ok(())
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
/// 已确认未提交时清理目录；若存储替换后的同步失败，保留目录供重启恢复。
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
    if result.is_err()
        && store
            .read(|db| Ok(db[RECORDS].get(&id).is_none()))
            .unwrap_or(false)
    {
        let _ = host_fs::remove_dir_all(&root);
    }
    result
}

/// 已冻结的目录快照。只返回服务端目录标识和内容摘要，不返回宿主路径。
#[derive(Clone, Debug)]
pub(super) struct Snapshot {
    pub(super) directory_id: String,
    pub(super) content_digest: String,
}

/// 从已登记目录复制一棵独立文件树，并在登记目录记录的同一笔更新中冻结目标。
///
/// `register` 用于把快照引用写入上层业务记录。源目录只在存储读锁内读取，目标目录
/// 不会复用源目录，因此后续执行器拿到的目录能力不会改写配置包源内容。
pub(super) fn snapshot<T>(
    store: &Store,
    source_id: &str,
    rules: Rules,
    register: impl FnOnce(&mut Value, Snapshot) -> Result<T, Error>,
) -> Result<T, Error> {
    let (_, source_root) = located(store, source_id)?;
    let digest = Rc::new(RefCell::new(None));
    let seed_digest = Rc::clone(&digest);
    let result = allocate(
        store,
        rules,
        |target| {
            let value = store.read(|_| copy_tree(&source_root, target))?;
            *seed_digest.borrow_mut() = Some(value);
            Ok(())
        },
        move |db, directory_id| {
            let content_digest = digest
                .borrow_mut()
                .take()
                .ok_or_else(|| Error::Internal("目录快照摘要缺失".into()))?;
            let snapshot = Snapshot {
                directory_id: directory_id.to_owned(),
                content_digest,
            };
            freeze(db, directory_id)?;
            register(db, snapshot)
        },
    );
    result
}

const SNAPSHOT_ENTRY_MAX: usize = 20_000;

fn copy_tree(source: &FsPath, target: &FsPath) -> Result<String, Error> {
    fs::verify(source)?;
    let mut digest = Sha256::new();
    let mut count = 0;
    copy_directory(source, target, "", &mut digest, &mut count)?;
    make_read_only(target)?;
    sync_host_directory(target)?;
    Ok(digest.finish())
}

fn copy_directory(
    source: &FsPath,
    target: &FsPath,
    prefix: &str,
    digest: &mut Sha256,
    count: &mut usize,
) -> Result<(), Error> {
    let mut entries = host_fs::read_dir(source)
        .map_err(|_| Error::Internal("目录快照读取失败".into()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| Error::Internal("目录快照读取失败".into()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| Error::Internal("目录快照包含无效名称".into()))?;
        if name.starts_with(".workbench-tmp-") {
            continue;
        }
        *count += 1;
        if *count > SNAPSHOT_ENTRY_MAX {
            return Err(Error::Invalid("目录内条目过多，无法建立快照".into()));
        }
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let source_path = entry.path();
        let target_path = target.join(&name);
        let metadata = host_fs::symlink_metadata(&source_path)
            .map_err(|_| Error::Internal("目录快照读取失败".into()))?;
        if metadata.file_type().is_symlink() {
            return Err(Error::Internal("目录快照不能包含符号链接".into()));
        }
        if metadata.is_dir() {
            digest.update(b"D");
            digest.update(relative.as_bytes());
            host_fs::DirBuilder::new()
                .mode(0o700)
                .create(&target_path)
                .map_err(|_| Error::Internal("目录快照创建失败".into()))?;
            copy_directory(&source_path, &target_path, &relative, digest, count)?;
            sync_host_directory(&target_path)?;
        } else if metadata.is_file() {
            if metadata.len() > fs::FILE_LIMIT {
                return Err(Error::Invalid("目录内文件超过大小上限".into()));
            }
            let bytes = host_fs::read(&source_path)
                .map_err(|_| Error::Internal("目录快照读取失败".into()))?;
            digest.update(b"F");
            digest.update(relative.as_bytes());
            digest.update(&(bytes.len() as u64).to_be_bytes());
            digest.update(&bytes);
            let mut file = host_fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&target_path)
                .map_err(|_| Error::Internal("目录快照创建失败".into()))?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| Error::Internal("目录快照写入失败".into()))?;
        } else {
            return Err(Error::Internal("目录快照包含不支持的文件类型".into()));
        }
    }
    Ok(())
}

fn make_read_only(path: &FsPath) -> Result<(), Error> {
    let metadata = host_fs::symlink_metadata(path)
        .map_err(|_| Error::Internal("目录快照权限设置失败".into()))?;
    if metadata.file_type().is_symlink() {
        return Err(Error::Internal("目录快照不能包含符号链接".into()));
    }
    if metadata.is_dir() {
        for entry in
            host_fs::read_dir(path).map_err(|_| Error::Internal("目录快照权限设置失败".into()))?
        {
            let entry = entry.map_err(|_| Error::Internal("目录快照权限设置失败".into()))?;
            make_read_only(&entry.path())?;
        }
        host_fs::set_permissions(path, host_fs::Permissions::from_mode(0o500))
            .map_err(|_| Error::Internal("目录快照权限设置失败".into()))?;
    } else if metadata.is_file() {
        host_fs::set_permissions(path, host_fs::Permissions::from_mode(0o400))
            .map_err(|_| Error::Internal("目录快照权限设置失败".into()))?;
    }
    Ok(())
}

fn sync_host_directory(path: &FsPath) -> Result<(), Error> {
    host_fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| Error::Internal("目录快照同步失败".into()))
}

struct Sha256 {
    state: [u32; 8],
    buffer: [u8; 64],
    buffered: usize,
    length: u64,
}

impl Sha256 {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buffer: [0; 64],
            buffered: 0,
            length: 0,
        }
    }

    fn update(&mut self, bytes: &[u8]) {
        self.length += bytes.len() as u64;
        let mut input = bytes;
        if self.buffered != 0 {
            let count = (64 - self.buffered).min(input.len());
            self.buffer[self.buffered..self.buffered + count].copy_from_slice(&input[..count]);
            self.buffered += count;
            input = &input[count..];
            if self.buffered == 64 {
                let block = self.buffer;
                self.compress(&block);
                self.buffered = 0;
            }
        }
        while input.len() >= 64 {
            self.compress(&input[..64]);
            input = &input[64..];
        }
        self.buffer[..input.len()].copy_from_slice(input);
        self.buffered = input.len();
    }

    fn finish(mut self) -> String {
        let bit_length = self.length * 8;
        self.buffer[self.buffered] = 0x80;
        self.buffered += 1;
        if self.buffered > 56 {
            self.buffer[self.buffered..].fill(0);
            let block = self.buffer;
            self.compress(&block);
            self.buffered = 0;
        }
        self.buffer[self.buffered..56].fill(0);
        self.buffer[56..].copy_from_slice(&bit_length.to_be_bytes());
        let block = self.buffer;
        self.compress(&block);
        self.state
            .iter()
            .map(|part| format!("{part:08x}"))
            .collect()
    }

    fn compress(&mut self, block: &[u8]) {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2,
        ];
        let mut words = [0u32; 64];
        for (index, chunk) in block.chunks_exact(4).take(16).enumerate() {
            words[index] = u32::from_be_bytes(chunk.try_into().unwrap());
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }
        let mut state = self.state;
        for index in 0..64 {
            let s1 =
                state[4].rotate_right(6) ^ state[4].rotate_right(11) ^ state[4].rotate_right(25);
            let choice = (state[4] & state[5]) ^ (!state[4] & state[6]);
            let temp1 = state[7]
                .wrapping_add(s1)
                .wrapping_add(choice)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let s0 =
                state[0].rotate_right(2) ^ state[0].rotate_right(13) ^ state[0].rotate_right(22);
            let majority = (state[0] & state[1]) ^ (state[0] & state[2]) ^ (state[1] & state[2]);
            let temp2 = s0.wrapping_add(majority);
            state = [
                temp1.wrapping_add(temp2),
                state[0],
                state[1],
                state[2],
                state[3].wrapping_add(temp1),
                state[4],
                state[5],
                state[6],
            ];
        }
        for (left, right) in self.state.iter_mut().zip(state) {
            *left = left.wrapping_add(right);
        }
    }
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
