use super::{Error, Store, convert, find};
use crate::work::{
    directories::{self, fs},
    patches,
};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::Value;
use std::{collections::HashSet, path::Path as FsPath};

const REQUESTS: &str = "workListGenerations";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Generate {
    request_id: String,
}

enum Start {
    Replay(Value),
    Convert(Value),
}

fn replay(db: &Value, id: &str, request: &str) -> Result<Option<Value>, Error> {
    let Some(patch_id) = db[REQUESTS][id].get(request) else {
        return Ok(None);
    };
    let corrupt = || Error::Internal("生成请求指向无效的工作包".into());
    Ok(Some(
        db["workPatches"]
            .get(patch_id.as_str().ok_or_else(corrupt)?)
            .cloned()
            .ok_or_else(corrupt)?,
    ))
}

pub(super) async fn handle(
    State((store, platform)): State<(Store, ursi_mcp::McpPlatform)>,
    Path(id): Path<String>,
    Json(input): Json<Generate>,
) -> Result<Json<Value>, Error> {
    let request = input.request_id;
    if request.trim().is_empty() || request.len() > 256 || request.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "requestId 需为 1 至 256 字节，且不含控制字符".into(),
        ));
    }
    let item = match store.read(|db| {
        let row = find(db, &id)?;
        if let Some(patch) = replay(db, &id, &request)? {
            return Ok(Start::Replay(patch));
        }
        if row["recipe"].is_null() {
            return Err(Error::Invalid("工作项尚未设置生成配方".into()));
        }
        Ok(Start::Convert(row.clone()))
    })? {
        Start::Replay(patch) => return Ok(Json(patch)),
        Start::Convert(item) => item,
    };
    let generated = convert::convert(&platform, &item).await?;
    tokio::task::spawn_blocking(move || {
        publish(&store, &id, &request, &item["revision"], generated)
    })
    .await
    .map_err(|_| Error::Internal("工作包生成任务中断".into()))?
    .map(Json)
}

pub(super) fn publish(
    store: &Store,
    id: &str,
    request: &str,
    revision: &Value,
    generated: convert::Generated,
) -> Result<Value, Error> {
    let convert::Generated {
        name,
        files,
        provenance,
    } = generated;
    let name = patches::valid_name(&name)?;
    let mut winner = None;
    let result = directories::allocate(
        store,
        directories::Rules::default(),
        |root| seed(root, &files),
        |db, directory_id| {
            if find(db, id).ok().map(|row| &row["revision"]) != Some(revision) {
                return Err(Error::Conflict("工作项已修改或删除，生成结果未发布".into()));
            }
            // 返回错误以回滚本次分配的目录，随后返回已发布的那一个包。
            winner = replay(db, id, request)?;
            if winner.is_some() {
                return Err(Error::Conflict("生成请求已发布".into()));
            }
            let row = patches::register_generated(db, name, directory_id, id, provenance)?;
            db[REQUESTS][id][request] = row["id"].clone();
            Ok(row)
        },
    );
    match winner {
        Some(patch) => Ok(patch),
        None => result,
    }
}

fn seed(root: &FsPath, files: &[(String, Vec<u8>)]) -> Result<(), Error> {
    if files.is_empty() {
        return Err(Error::Invalid("转换未返回文件".into()));
    }
    let mut dirs = HashSet::new();
    for (path, bytes) in files {
        let parts = fs::segments(path, false)?;
        for depth in 1..parts.len() {
            let prefix = &parts[..depth];
            if dirs.insert(prefix.to_vec()) {
                fs::mkdir(root, prefix)?;
            }
        }
        fs::write(root, &parts, bytes, false)?;
    }
    // 文件和子目录已同步，再持久化包根在 directories/ 下的目录项。
    let parent = root
        .parent()
        .ok_or_else(|| Error::Internal("工作包目录缺少上级目录".into()))?;
    std::fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| Error::Internal(format!("工作包目录同步失败：{e}")))
}
