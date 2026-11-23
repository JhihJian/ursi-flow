//! 工作包生成：生成器目录、显式运行与隔离转换。
pub(super) mod convert;
mod generators;
mod runs;

use super::{Error, Store, valid_label};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use ursi_mcp::McpPlatform;

pub(super) use runs::recover;

pub(super) fn routes(store: Store, platform: McpPlatform) -> Router {
    generators::routes(store.clone()).merge(runs::routes(store, platform))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::work) struct Resource {
    pub(in crate::work) alias: String,
    pub(in crate::work) server_id: String,
    pub(in crate::work) uri: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(in crate::work) struct GeneratorRef {
    pub(in crate::work) id: String,
    pub(in crate::work) revision: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(in crate::work) struct Binding {
    pub(in crate::work) id: String,
    pub(in crate::work) revision: u64,
    pub(in crate::work) resources: Vec<Resource>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(in crate::work) struct Recipe {
    pub(in crate::work) resources: Vec<Resource>,
    pub(in crate::work) script: String,
}

pub(in crate::work) fn resolve<'a>(
    db: &'a Value,
    id: &str,
    revision: u64,
    resources: &[Resource],
) -> Result<&'a Value, Error> {
    let generator = generators::generator(db, id, revision)?;
    let aliases = generator["aliases"].as_array().ok_or_else(corrupt)?;
    let unique: HashSet<_> = resources.iter().map(|r| r.alias.as_str()).collect();
    if resources.len() != aliases.len()
        || unique.len() != aliases.len()
        || !aliases
            .iter()
            .all(|a| a.as_str().is_some_and(|s| unique.contains(s)))
        || resources
            .iter()
            .any(|r| !valid_label(&r.server_id, 128) || !valid_label(&r.uri, 4096))
    {
        return Err(Error::Invalid(
            "资源引用必须与生成器输入别名一一对应".into(),
        ));
    }
    Ok(generator)
}

pub(in crate::work) fn corrupt() -> Error {
    Error::Internal("生成器记录损坏".into())
}
