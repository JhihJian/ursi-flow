//! 分离部署仍使用业务库的目录接口，但旧库中的平台目录不能被列举或寻址。
use super::{Error, Store, directories};
use axum::{
    Json, Router,
    extract::{RawPathParams, Request, State},
    http::Method,
    middleware::{Next, from_fn_with_state},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{collections::HashSet, io, sync::Arc};

pub(super) fn routes(store: Store) -> io::Result<Router> {
    // 分离部署不再写这两张平台表；只在打开库时建立索引，不随每次文件请求扫描尝试历史。
    let hidden = store
        .read(legacy_platform_ids)
        .map_err(|err| io::Error::other(format!("无法确认存量平台目录的归属：{err:?}")))?;
    Ok(directories::routes(store.clone())?
        .route_layer(from_fn_with_state((store, Arc::new(hidden)), business_only)))
}

fn corrupt() -> Error {
    Error::Internal("目录归属记录损坏".into())
}

fn legacy_platform_ids(db: &Value) -> Result<HashSet<String>, Error> {
    let mut hidden = HashSet::new();
    if let Some(packages) = db.get("configPatches") {
        for package in packages.as_object().ok_or_else(corrupt)?.values() {
            hidden.insert(
                package["directoryId"]
                    .as_str()
                    .ok_or_else(corrupt)?
                    .to_owned(),
            );
        }
    }
    if let Some(attempts) = db.get("executorAttempts") {
        for attempt in attempts.as_object().ok_or_else(corrupt)?.values() {
            let id = &attempt["result"]["artifactDirectoryId"];
            if !id.is_null() {
                hidden.insert(id.as_str().ok_or_else(corrupt)?.to_owned());
            }
        }
    }
    Ok(hidden)
}

async fn business_only(
    State((store, hidden)): State<(Store, Arc<HashSet<String>>)>,
    params: RawPathParams,
    request: Request,
    next: Next,
) -> Result<Response, Error> {
    // 使用 axum 已解码的路由参数，与下游目录处理器的 Path(id) 一致。
    if let Some((_, id)) = params.iter().find(|(key, _)| *key == "id") {
        // The proxy owns namespaced artifact handles. Never interpret one as a
        // local directory, including on methods not mounted by the proxy.
        if !uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
            || hidden.contains(id)
        {
            return Err(Error::NotFound("目录不存在".into()));
        }
    } else if matches!(*request.method(), Method::GET | Method::HEAD) {
        let list = store.read(|db| {
            let mut list = Vec::new();
            if let Some(rows) = db.get("directories") {
                for (id, row) in rows.as_object().ok_or_else(corrupt)? {
                    if !hidden.contains(id) {
                        if row["id"] != id.as_str() {
                            return Err(corrupt());
                        }
                        list.push(json!({"id":id}));
                    }
                }
            }
            Ok(list)
        })?;
        return Ok(Json(list).into_response());
    }
    Ok(next.run(request).await)
}
