//! 工作区准备：草稿、材料收存与查询。冻结后不能再改需求或材料，允许重跑 SOP。
//!
//! 材料正文存放在 `store.dir()/workspace-files/<工作区 UUID>/<角色>`，文件名取角色，
//! 不使用上传文件名；同一角色只能收存一次，因此元数据里的 name、size 始终与实际文件一致。
mod model;
#[cfg(test)]
mod tests;

use super::{Error, Store};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    routing::{get, put},
};
use model::{Draft, Edit};
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path as FsPath, PathBuf},
};
use uuid::Uuid;

type Reply = Result<Json<Value>, Error>;

/// 单份材料正文上限。超限请求由这里给出明确错误，路由同样限制请求体大小。
const MATERIAL_LIMIT: u64 = 16 * 1024 * 1024;

pub(super) fn routes(store: Store) -> Router {
    Router::new()
        .route("/v2/workspaces", get(list).post(create))
        .route("/v2/workspaces/{id}", get(detail).patch(edit))
        .route(
            "/v2/workspaces/{id}/materials/{role}",
            put(upload).layer(DefaultBodyLimit::max(MATERIAL_LIMIT as usize + 1)),
        )
        .with_state(store)
}

async fn create(State(store): State<Store>, Json(body): Json<Draft>) -> Reply {
    store.update(|db| model::create(db, body)).map(Json)
}

async fn list(State(store): State<Store>) -> Reply {
    store.read(model::list).map(Json)
}

async fn detail(State(store): State<Store>, Path(id): Path<String>) -> Reply {
    store
        .read(|db| model::workspace(db, &id).cloned())
        .map(Json)
}

async fn edit(State(store): State<Store>, Path(id): Path<String>, Json(body): Json<Edit>) -> Reply {
    store
        .update(|db| model::edit(model::workspace_mut(db, &id)?, body))
        .map(Json)
}

#[derive(Deserialize)]
struct Upload {
    name: String,
}

fn within_limit(size: u64) -> Result<(), Error> {
    if size > MATERIAL_LIMIT {
        return Err(Error::Invalid("单份材料最大 16 MiB".into()));
    }
    Ok(())
}

async fn upload(
    State(store): State<Store>,
    Path((id, role)): Path<(String, String)>,
    Query(query): Query<Upload>,
    body: Bytes,
) -> Reply {
    let size = body.len() as u64;
    within_limit(size)?;
    if !model::plain_name(&query.name) {
        return Err(Error::Invalid("材料文件名无效".into()));
    }
    if !model::plain_name(&role) {
        return Err(Error::Invalid("材料角色无效".into()));
    }
    let workspace = store.read(|db| {
        let doc = model::workspace(db, &id)?;
        model::material_slot(doc, &role)?;
        Uuid::parse_str(
            doc["id"]
                .as_str()
                .ok_or_else(|| Error::Internal("无效的工作区记录：标识".into()))?,
        )
        .map_err(|_| Error::Internal("无效的工作区记录：标识".into()))
    })?;
    let dir = store
        .dir()
        .join("workspace-files")
        .join(workspace.to_string());
    let bytes = body.to_vec();
    let stage_dir = dir.clone();
    let staged = tokio::task::spawn_blocking(move || stage(&stage_dir, &bytes))
        .await
        .map_err(|_| Error::Internal("材料写入任务中断".into()))?
        .map_err(|e| Error::Internal(format!("材料写入失败：{e}")))?;
    let result = store.update(|db| {
        let doc = model::workspace_mut(db, &id)?;
        model::material_slot(doc, &role)?;
        publish(&dir, &role, &staged).map_err(|e| Error::Internal(format!("材料收存失败：{e}")))?;
        model::add_material(doc, &role, &query.name, size)
    });
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result.map(Json)
}

fn private_dir(dir: &FsPath) -> io::Result<()> {
    DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    let meta = fs::symlink_metadata(dir)?;
    if !meta.is_dir() || meta.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "材料目录必须为服务账户私有目录",
        ));
    }
    Ok(())
}

/// 先把正文写到同一目录的私有临时文件，收存时整体改名，避免半份材料被读到。
fn stage(dir: &FsPath, bytes: &[u8]) -> io::Result<PathBuf> {
    private_dir(dir)?;
    let tmp = dir.join(format!(".{}.upload", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&tmp)?;
    match file.write_all(bytes).and_then(|()| file.sync_all()) {
        Ok(()) => Ok(tmp),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn publish(dir: &FsPath, role: &str, staged: &FsPath) -> io::Result<()> {
    fs::rename(staged, dir.join(role))?;
    File::open(dir)?.sync_all()
}
