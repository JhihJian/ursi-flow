//! Local administrator-owned inputs. Never interpolate a route parameter into a path.
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Map, Value};
use std::{
    collections::BTreeSet,
    fs::OpenOptions,
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

pub(super) const CONFIG_LIMIT: u64 = 64 * 1024;
pub(super) const EXPORT_LIMIT: u64 = 1024 * 1024;

pub(super) fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "来源文件格式或配置无效")
}

pub(super) fn read_json<T: DeserializeOwned>(path: &Path, limit: u64) -> io::Result<T> {
    if !path.is_absolute() {
        return Err(invalid());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.mode() & 0o077 != 0
        || !(meta.uid() == 0 || meta.uid() == unsafe { libc::geteuid() })
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "来源文件必须为管理员或服务账户所有的私有普通文件",
        ));
    }
    if meta.len() > limit {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid());
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Resource {
    pub id: String,
    pub title: String,
    pub input: Map<String, Value>,
}

pub(super) fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub(super) fn resources(path: &Path) -> io::Result<Vec<Resource>> {
    let items: Vec<Resource> = read_json(path, EXPORT_LIMIT)?;
    let mut ids = BTreeSet::new();
    for item in &items {
        if !name(&item.id) || item.title.trim().is_empty() || !ids.insert(&item.id) {
            return Err(invalid());
        }
    }
    Ok(items)
}
