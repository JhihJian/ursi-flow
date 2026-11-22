//! 将管理员文件投影为允许公开的标识与冻结所需的摘要。
use super::{Error, definitions::name};
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};
use url::Url;

#[derive(Default)]
pub(super) struct Policy {
    pub models: Vec<String>,
    pub tools: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    models: Vec<Model>,
    tools: Vec<Tool>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Model {
    id: String,
    #[serde(rename = "provider")]
    _provider: Map<String, Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Tool {
    id: String,
    url: String,
    name: String,
    input_schema: Map<String, Value>,
    read_only: bool,
    token: Option<String>,
}

fn unavailable() -> Error {
    Error::Unavailable("Agent 管理员策略不可用".into())
}

pub(super) fn load() -> Result<Policy, Error> {
    match std::env::var_os("URSI_PI_POLICY") {
        Some(path) => read(Path::new(&path)),
        None => Ok(Policy::default()),
    }
}

fn read(path: &Path) -> Result<Policy, Error> {
    if !path.is_absolute() {
        return Err(unavailable());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| unavailable())?;
    let meta = file.metadata().map_err(|_| unavailable())?;
    if !meta.is_file()
        || meta.mode() & 0o7777 != 0o600
        || (meta.uid() != 0 && meta.uid() != unsafe { libc::geteuid() })
    {
        return Err(unavailable());
    }
    const LIMIT: u64 = 2 * 1024 * 1024;
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() as u64 > LIMIT {
        return Err(unavailable());
    }
    parse(&bytes)
}

fn parse(bytes: &[u8]) -> Result<Policy, Error> {
    let doc: Document = serde_json::from_slice(bytes).map_err(|_| unavailable())?;
    let mut policy = Policy::default();
    let mut ids = BTreeSet::new();
    for model in doc.models {
        if name(&model.id).is_err() || !ids.insert(model.id.clone()) {
            return Err(unavailable());
        }
        policy.models.push(model.id);
    }
    for tool in doc.tools {
        let url = Url::parse(&tool.url).map_err(|_| unavailable())?;
        if !tool.read_only
            || name(&tool.id).is_err()
            || name(&tool.name).is_err()
            || !matches!(url.scheme(), "http" | "https")
            || !url.has_host()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || tool
                .url
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
            || tool
                .token
                .as_ref()
                .is_some_and(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_graphic()))
        {
            return Err(unavailable());
        }
        let mut schema = Value::Object(tool.input_schema);
        schema.sort_all_objects();
        let bytes = serde_json::to_vec(&schema).map_err(|_| unavailable())?;
        let digest = format!("{:x}", Sha256::digest(bytes));
        if policy.tools.insert(tool.id, digest).is_some() {
            return Err(unavailable());
        }
    }
    Ok(policy)
}
