//! 读取本次配方的材料，运行隔离转换并校验待发布的文件。
mod sandbox;
#[cfg(test)]
mod tests;
use crate::work::{Error, directories, mcp::from_mcp_error};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::timeout;
use ursi_mcp::{McpPlatform, Operation};
const SNAPSHOT_LIMIT: usize = 4 * 1024 * 1024;
fn invalid(s: &str) -> Error {
    Error::Invalid(s.into())
}
fn unavailable(s: &str) -> Error {
    Error::Unavailable(s.into())
}
fn label(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
pub(super) struct Generated {
    pub(super) name: String,
    pub(super) files: Vec<(String, Vec<u8>)>,
    pub(super) provenance: Value,
}
use super::Recipe;

pub(super) struct Progress {
    pub stage: &'static str,
    pub evidence: Vec<Value>,
}
impl Default for Progress {
    fn default() -> Self {
        Self {
            stage: "read",
            evidence: Vec::new(),
        }
    }
}

pub(super) async fn convert(platform: &McpPlatform, item: &Value) -> Result<Generated, Error> {
    let recipe: Recipe =
        serde_json::from_value(item["recipe"].clone()).map_err(|_| invalid("工作项配方无效"))?;
    execute(platform, Some(item), &recipe, &mut Progress::default()).await
}

pub(super) async fn execute(
    platform: &McpPlatform,
    item: Option<&Value>,
    recipe: &Recipe,
    progress: &mut Progress,
) -> Result<Generated, Error> {
    timeout(
        Duration::from_secs(45),
        convert_inner(platform, item, recipe, progress),
    )
    .await
    .map_err(|_| unavailable("资源转换超时"))?
}

async fn convert_inner(
    platform: &McpPlatform,
    item: Option<&Value>,
    recipe: &Recipe,
    progress: &mut Progress,
) -> Result<Generated, Error> {
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
    let snapshots = if recipe.resources.is_empty() {
        json!({})
    } else {
        let mut operation = platform.operation().map_err(from_mcp_error)?;
        read_resources(&mut operation, recipe, &mut progress.evidence).await?
    };
    progress.stage = "convert";
    let input =
        json!({"item":item.map(item_snapshot),"resources":snapshots,"script":recipe.script});
    let output = sandbox::run(&input).await?;
    progress.stage = "validate";
    let mut provenance = json!({"scriptSha256":format!("{:x}",Sha256::digest(recipe.script.as_bytes())),"resources":progress.evidence});
    if let Some(item) = item {
        provenance["workItemId"] = item["id"].clone();
        provenance["workItemTitle"] = item["title"].clone();
        provenance["revision"] = item["revision"].clone();
    }
    package(output, provenance)
}

async fn read_resources(
    operation: &mut Operation<'_>,
    recipe: &Recipe,
    evidence: &mut Vec<Value>,
) -> Result<Value, Error> {
    let mut snapshots = json!({});
    let mut size = 0;
    for r in &recipe.resources {
        let contents = operation
            .read_resource(&r.server_id, &r.uri)
            .await
            .map_err(from_mcp_error)?;
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
    Ok(snapshots)
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
