use super::{Check, Registry};
use crate::work::{Error, Store, catalog, executor};
use axum::{
    Json, Router,
    extract::{Path as RoutePath, Query, State},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs, io,
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::Path,
};

type Api = (Registry, Store);
type Reply = Result<Json<Value>, Error>;

impl Registry {
    pub(in crate::work) fn routes(&self, store: Store) -> Router {
        Router::new()
            .route("/v2/agent-backends", get(list))
            .route("/v2/agent-backends/{id}/check", post(check))
            .with_state((self.clone(), store))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Filter {
    config_package_id: Option<String>,
}

async fn list(State((registry, store)): State<Api>, Query(filter): Query<Filter>) -> Reply {
    let snapshot = match filter.config_package_id {
        None => None,
        Some(id) => Some(
            tokio::task::spawn_blocking(move || {
                catalog::agent_preview(
                    &store,
                    &json!({"id":"preview","agent":{"configPackageId":id}}),
                )
            })
            .await
            .map_err(|_| Error::Internal("配置包解析任务中断".into()))??,
        ),
    };
    let health = registry.health()?;
    Ok(Json(Value::Array(
        registry
            .0
            .backends
            .iter()
            .map(|b| b.view(health.get(&b.info.id), snapshot.as_ref()))
            .collect(),
    )))
}

fn workspace_root(root: &Path) -> io::Result<()> {
    match fs::DirBuilder::new().mode(0o700).create(root) {
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
        result => result?,
    }
    let meta = root.symlink_metadata()?;
    if !meta.is_dir() || meta.mode() & 0o077 != 0 || meta.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "执行工作区必须为私有目录",
        ));
    }
    Ok(())
}

async fn check(State((registry, store)): State<Api>, RoutePath(id): RoutePath<String>) -> Reply {
    let b = registry
        .backend(&id)
        .ok_or_else(|| Error::NotFound("Agent 后端不存在".into()))?;
    // 同一后端串行探测；等待协议响应期间仍可列出目录和读取上一次检查结果。
    let _guard = b.probe_lock.lock().await;
    let root = store.dir().join("executor-workspaces");
    let ready = match &b.entry {
        Some(e) if workspace_root(&root).is_ok() => executor::probe_agent(&e.bin, &e.policy, &root)
            .await
            .is_ok(),
        _ => false,
    };
    let result = Check::finished(ready);
    let view = b.view(Some(&result), None);
    registry.health()?.insert(id, result);
    Ok(Json(view))
}
