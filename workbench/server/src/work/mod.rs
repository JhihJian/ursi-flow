//! Workbench 持有业务数据，通过平台的消费者接口选版、执行并读取制品。
mod business_directories;
mod environment;
mod generation;
mod mcp;
mod patches;
mod platform_proxy;
mod worklist;
use axum::Router;
use std::{io, path::PathBuf};
use ursi_executor_platform::work::{Error, Store, directories};

fn valid_label(s: &str, limit: usize) -> bool {
    !s.is_empty() && s.len() <= limit && s.trim() == s && !s.chars().any(char::is_control)
}

pub(crate) fn routes(dir: PathBuf) -> io::Result<Router> {
    let store = Store::open(dir)?;
    let platform = platform_proxy::routes(store.clone())?;
    let config_lookup = platform_proxy::Platform::configured(store.clone())?;
    Ok(business(store, Some(config_lookup))?.merge(platform))
}

#[cfg(test)]
pub(crate) fn business_routes(store: Store) -> io::Result<Router> {
    business(store, None)
}

fn business(store: Store, config_lookup: Option<platform_proxy::Platform>) -> io::Result<Router> {
    generation::recover(&store)
        .map_err(|err| io::Error::other(format!("恢复生成运行失败：{err:?}")))?;
    let mcp = mcp::platform(&store);
    Ok(business_directories::routes(store.clone())?
        .merge(worklist::routes(store.clone()))
        .merge(generation::routes(store.clone(), mcp.clone()))
        .nest("/v2", mcp.routes())
        .merge(environment::routes(store.clone()))
        .merge(patches::routes_with_platform(store, config_lookup)))
}
