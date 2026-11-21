//! 平台资源连接与工作包转换。不负责发布目录或修改工作项。
mod client;
mod policy;
mod sandbox;
#[cfg(test)]
mod tests;

use super::{Error, Store, directories};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::Semaphore, time::timeout};
use uuid::Uuid;

const TABLE: &str = "mcpServers";
const SNAPSHOT_LIMIT: usize = 4 * 1024 * 1024;
static SLOTS: Semaphore = Semaphore::const_new(4);

#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Binding {
    #[default]
    Policy,
    Platform,
}
impl Binding {
    fn is_policy(&self) -> bool {
        *self == Self::Policy
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    name: String,
    url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential_env: Option<String>,
    #[serde(default, skip_serializing_if = "Binding::is_policy")]
    binding: Binding,
}
fn invalid(s: &str) -> Error {
    Error::Invalid(s.into())
}
fn unavailable(s: &str) -> Error {
    Error::Unavailable(s.into())
}
fn missing() -> Error {
    Error::NotFound("MCP 服务不存在".into())
}
fn label(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
fn slot() -> Result<tokio::sync::SemaphorePermit<'static>, Error> {
    SLOTS
        .try_acquire()
        .map_err(|_| unavailable("MCP 请求过多，请稍后重试"))
}

pub(super) fn routes(store: Store) -> Router {
    Router::new()
        .route("/v2/mcp-servers", get(index).post(register))
        .route("/v2/mcp-servers/{id}", delete(remove))
        .route("/v2/mcp-servers/{id}/inspection", get(inspect))
        .route("/v2/mcp-servers/{id}/resources", get(resources))
        .route("/v2/mcp-servers/{id}/resources/read", post(read_resource))
        .layer(DefaultBodyLimit::max(8192))
        .with_state(store)
}
async fn index(State(store): State<Store>) -> Result<Json<Value>, Error> {
    store.read(|db| match db.get(TABLE) {
        None => Ok(Json(json!([]))),
        Some(rows) => Ok(Json(json!(
            rows.as_object()
                .ok_or_else(|| Error::Internal("MCP 服务表损坏".into()))?
                .values()
                .collect::<Vec<_>>()
        ))),
    })
}
async fn register(
    State(store): State<Store>,
    Json(mut config): Json<Config>,
) -> Result<Json<Value>, Error> {
    config.name = config.name.trim().into();
    if !label(&config.name, 240) {
        return Err(invalid("服务名称无效"));
    }
    policy::authorize(&store, &config)?;
    if config.binding == Binding::Platform
        && let Some(key) = config.credential_env.as_deref()
    {
        let value = super::environment::lookup(&store, key)?
            .ok_or_else(|| invalid("所选平台变量不存在，请先在环境变量页保存"))?;
        if !policy::valid_bearer(&value) {
            return Err(invalid("所选变量不能用作 Bearer 令牌，请检查空格或换行"));
        }
    }
    let id = Uuid::new_v4().to_string();
    let mut row = json!(config);
    row["id"] = json!(id);
    store.update(|db| {
        let rows = db
            .as_object_mut()
            .unwrap()
            .entry(TABLE)
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| Error::Internal("MCP 服务表损坏".into()))?;
        if rows.len() >= 128 {
            return Err(invalid("最多登记 128 个 MCP 服务"));
        }
        rows.insert(id, row.clone());
        Ok(Json(row))
    })
}
async fn remove(State(store): State<Store>, Path(id): Path<String>) -> Result<Json<Value>, Error> {
    store.update(|db| {
        db[TABLE]
            .as_object_mut()
            .and_then(|rows| rows.remove(&id))
            .ok_or_else(missing)?;
        Ok(Json(json!({"id":id})))
    })
}
fn lookup(store: &Store, id: &str) -> Result<Config, Error> {
    store.read(|db| {
        let mut row = db[TABLE].get(id).cloned().ok_or_else(missing)?;
        row.as_object_mut().ok_or_else(missing)?.remove("id");
        serde_json::from_value(row).map_err(|_| Error::Internal("MCP 服务记录损坏".into()))
    })
}
async fn inspect(State(store): State<Store>, Path(id): Path<String>) -> Result<Json<Value>, Error> {
    discover(&store, &id, true).await
}

async fn resources(
    State(store): State<Store>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    discover(&store, &id, false).await
}

async fn discover(store: &Store, id: &str, inspection: bool) -> Result<Json<Value>, Error> {
    let cfg = lookup(store, id)?;
    let _permit = slot()?;
    timeout(Duration::from_secs(25), async {
        let conn = client::Session::open(store, &cfg).await?;
        let result = async {
            if !inspection {
                return conn.list().await.map(Value::Array);
            }
            let server = conn.info()?;
            let resources = if conn.has_resources() {
                conn.list().await?
            } else {
                vec![]
            };
            Ok(json!({"server":server,"resources":resources}))
        }
        .await;
        conn.close().await;
        result.map(Json)
    })
    .await
    .map_err(|_| unavailable("MCP 资源发现超时"))?
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadRequest {
    uri: String,
}
async fn read_resource(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(request): Json<ReadRequest>,
) -> Result<Json<Value>, Error> {
    if !label(&request.uri, 4096) {
        return Err(invalid("资源 URI 无效"));
    }
    let _permit = slot()?;
    let cfg = lookup(&store, &id)?;
    timeout(Duration::from_secs(25), async {
        let conn = client::Session::open(&store, &cfg).await?;
        let result = conn.read(&request.uri).await;
        conn.close().await;
        result.map(|contents| Json(json!({"contents":contents})))
    })
    .await
    .map_err(|_| unavailable("MCP 资源读取超时"))?
}

pub(super) struct Generated {
    pub(super) name: String,
    pub(super) files: Vec<(String, Vec<u8>)>,
    pub(super) provenance: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reference {
    alias: String,
    server_id: String,
    uri: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Recipe {
    resources: Vec<Reference>,
    script: String,
}

pub(super) async fn convert(store: &Store, item: &Value) -> Result<Generated, Error> {
    let _permit = slot()?;
    timeout(Duration::from_secs(45), convert_inner(store, item))
        .await
        .map_err(|_| unavailable("资源转换超时"))?
}
async fn convert_inner(store: &Store, item: &Value) -> Result<Generated, Error> {
    let recipe: Recipe =
        serde_json::from_value(item["recipe"].clone()).map_err(|_| invalid("工作项配方无效"))?;
    if recipe.script.trim().is_empty() || recipe.script.len() > 65536 || recipe.resources.len() > 32
    {
        return Err(invalid("配方为空或超过上限"));
    }
    let mut aliases = HashSet::new();
    for r in &recipe.resources {
        if !label(&r.alias, 128)
            || !label(&r.uri, 4096)
            || !label(&r.server_id, 128)
            || !aliases.insert(&r.alias)
        {
            return Err(invalid("资源引用无效或别名重复"));
        }
    }
    let mut snapshots = json!({});
    let mut evidence = vec![];
    let mut size = 0;
    for r in &recipe.resources {
        let cfg = lookup(store, &r.server_id)?;
        let session = client::Session::open(store, &cfg).await?;
        let result = session.read(&r.uri).await;
        session.close().await;
        let contents = result
            .map_err(|_| unavailable(&format!("读取 MCP 资源失败：{}，{}", cfg.name, r.uri)))?;
        let bytes = serde_json::to_vec(&contents).map_err(|_| invalid("资源内容无效"))?;
        size += bytes.len();
        if size > SNAPSHOT_LIMIT {
            return Err(invalid("资源快照超过 4 MiB"));
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| unavailable("系统时间无效"))?
            .as_millis() as u64;
        evidence.push(json!({"serverId":r.server_id,"uri":r.uri,"alias":r.alias,"sha256":format!("{:x}",Sha256::digest(&bytes)),"readAt":now}));
        snapshots[&r.alias] = json!({"serverId":r.server_id,"uri":r.uri,"contents":contents});
    }
    let input = json!({"item":item_snapshot(item),"resources":snapshots,"script":recipe.script});
    let output = sandbox::run(&input).await?;
    let provenance = json!({"workItemId":item["id"],"workItemTitle":item["title"],"revision":item["revision"],"scriptSha256":format!("{:x}",Sha256::digest(recipe.script.as_bytes())),"resources":evidence});
    package(output, provenance)
}
fn item_snapshot(item: &Value) -> Value {
    json!({"id":item["id"],"title":item["title"],"description":item["description"],"category":item["category"],"status":item["status"]})
}

fn package(output: Value, provenance: Value) -> Result<Generated, Error> {
    let name = output["name"].as_str().unwrap_or("").trim();
    if !label(name, 320) || name.chars().count() > 80 {
        return Err(invalid("转换结果包名无效"));
    }
    let rows = output["files"]
        .as_array()
        .filter(|r| (1..=128).contains(&r.len()))
        .ok_or_else(|| invalid("files 必须为 1 至 128 项的数组"))?;
    let mut files = vec![];
    let mut paths = HashSet::new();
    let mut dirs = HashSet::new();
    let mut size = 0;
    for row in rows {
        let path = row["path"]
            .as_str()
            .ok_or_else(|| invalid("文件缺少路径"))?;
        directories::fs::segments(path, false)?;
        if dirs.contains(path) || !paths.insert(path) {
            return Err(invalid("重复路径或文件与目录冲突"));
        }
        for (i, _) in path.match_indices('/') {
            let dir = &path[..i];
            if paths.contains(dir) {
                return Err(invalid("文件与目录冲突"));
            }
            dirs.insert(dir);
        }
        let bytes = match (row.get("text"), row.get("blob")) {
            (Some(Value::String(s)), None) => s.as_bytes().to_vec(),
            (None, Some(Value::String(s))) => STANDARD
                .decode(s)
                .map_err(|_| invalid("文件 Base64 无效"))?,
            _ => return Err(invalid("文件需要 text 或 blob 二选一")),
        };
        size += bytes.len();
        if size > SNAPSHOT_LIMIT {
            return Err(invalid("生成文件超过 4 MiB"));
        }
        files.push((path.to_owned(), bytes));
    }
    Ok(Generated {
        name: name.to_owned(),
        files,
        provenance,
    })
}
