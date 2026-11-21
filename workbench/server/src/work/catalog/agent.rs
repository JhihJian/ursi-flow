//! Agent 草稿与发布共用只读解析，快照只含运行所需的固定正文和命名引用。
use super::{
    Error, Reply,
    definitions::{fields, id, name, text},
    policy,
};
use crate::work::{
    directories::{self, fs},
    patches,
};
use axum::Json;
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};
use std::{collections::BTreeSet, path::Path};

pub(super) async fn options() -> Reply {
    let policy = policy::load()?;
    Ok(Json(json!({
        "models": policy.models.iter().map(|id| json!({"id":id})).collect::<Vec<_>>(),
        "tools": policy.tools.keys().map(|id| json!({"id":id})).collect::<Vec<_>>(),
    })))
}

pub(in crate::work) const SNAPSHOT_LIMIT: usize = 2 * 1024 * 1024;

fn document(root: &Path, path: &str) -> Result<Vec<u8>, Error> {
    fs::read(root, &fs::segments(path, false)?).map_err(|e| match e {
        fs::Fault::NotFound(_) => Error::Invalid(format!("配置包缺少普通文件 {path}")),
        _ => e.into(),
    })
}

fn markdown(root: &Path, path: &str) -> Result<String, Error> {
    let bytes = document(root, path)?;
    let content = String::from_utf8(bytes)
        .map_err(|_| Error::Invalid(format!("{path} 必须是 UTF-8 正文")))?;
    if content.trim().is_empty() || content.len() > 256 * 1024 {
        return Err(Error::Invalid(format!("{path} 需要非空正文，最多 256 KiB")));
    }
    Ok(content)
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct Settings {
    #[serde(deserialize_with = "model_id")]
    model_profile: Option<String>,
    tools: Vec<String>,
    mcp_servers: Map<String, Value>,
}

// Only omission selects the default model. An explicit null is not a model ID.
fn model_id<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}

fn selection(config: Settings, policy: &policy::Policy) -> Result<(String, Vec<Value>), Error> {
    if !config.mcp_servers.is_empty() {
        return Err(Error::Invalid(
            "Agent 不支持非空 mcpServers，请在 tools 中引用管理员授权的工具 ID".into(),
        ));
    }
    let model = match config.model_profile.as_deref() {
        Some(id) => name(id)?,
        None => policy
            .models
            .first()
            .ok_or_else(|| Error::Invalid("管理员策略没有可用模型".into()))?,
    };
    if !policy.models.iter().any(|id| id == model) {
        return Err(Error::Invalid("模型未获管理员授权".into()));
    }
    let mut tools = Vec::new();
    if config.tools.len() > 64 {
        return Err(Error::Invalid("工具最多 64 个".into()));
    }
    let mut seen = BTreeSet::new();
    for tool in &config.tools {
        let id = name(tool)?;
        let digest = policy
            .tools
            .get(id)
            .ok_or_else(|| Error::Invalid("工具未获管理员授权".into()))?;
        if !seen.insert(id) {
            return Err(Error::Invalid("工具标识不能重复".into()));
        }
        tools.push(json!({"id":id,"schemaDigest":digest}));
    }
    Ok((model.to_owned(), tools))
}

/// 调用方持有 Store 锁，与目录 API 的写操作互斥，直到整份快照解析完毕。
pub(super) fn preview(store_dir: &Path, db: &Value, definition: &Value) -> Result<Value, Error> {
    fields(definition, &["id", "agent"])?;
    id(definition)?;
    let agent = &definition["agent"];
    fields(agent, &["configPackageId", "backendId"])?;
    if agent.get("backendId").is_some() {
        name(text(agent, "backendId")?)?;
    }
    let package = name(text(agent, "configPackageId")?)?;
    let directory = patches::config_package_directory(db, package)?;
    let root = directories::registered_root(store_dir, db, &directory)?;
    let bytes = document(&root, "mcp.json")?;
    // Serde also accepts positional arrays for structs; this contract is object-only.
    if bytes.trim_ascii_start().first() != Some(&b'{') {
        return Err(Error::Invalid("mcp.json 顶层必须是对象".into()));
    }
    let config = serde_json::from_slice(&bytes).map_err(|_| {
        Error::Invalid(
            "mcp.json 只接受含可选 modelProfile、tools 与空 mcpServers 对象的配置".into(),
        )
    })?;
    let (model, tools) = selection(config, &policy::load()?)?;
    let prompt = markdown(&root, "AGENTS.md")?;
    let names = fs::child_dirs(&root, &["skills".into()])?;
    if names.len() > 64 {
        return Err(Error::Invalid("Skill 最多 64 个".into()));
    }
    let mut skills = Vec::new();
    let mut size = prompt.len();
    for skill in names {
        name(&skill)?;
        let content = markdown(&root, &format!("skills/{skill}/SKILL.md"))?;
        size += content.len();
        if size > SNAPSHOT_LIMIT {
            return Err(too_large());
        }
        // 包文件无资源修订号；在每份独立快照内嵌为第 1 版。
        skills.push(json!({"id":skill,"revision":1,"content":content}));
    }
    let snapshot =
        json!({"systemPrompt":prompt,"modelProfile":model,"skills":skills,"tools":tools});
    if snapshot.to_string().len() > SNAPSHOT_LIMIT {
        return Err(too_large());
    }
    Ok(snapshot)
}

fn too_large() -> Error {
    Error::Invalid("Agent 快照超过 2 MiB".into())
}
