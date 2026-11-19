//! 包私有根内的目录服务。所有路径都是包根相对路径，由 API 传入的字符串拼装。
//!
//! 每一级都用 `symlink_metadata` 校验，任意一级为符号链接即拒绝；文件写入走同目录
//! 临时文件加 `rename`，并同步目录项，读取方不会看到半截内容。本模块不判断包的类别。
use serde::Serialize;
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
use uuid::Uuid;

/// 包根目录在 Server 私有目录中的位置，两类包分属其下的 `work` 和 `config`。
pub(super) const PACKAGES: &str = "patches";

/// 单个文件正文上限。路由按此限制请求体，本模块再校验一次。
pub(super) const FILE_LIMIT: u64 = 8 * 1024 * 1024;
const PATH_MAX: usize = 1024;
const SEGMENT_MAX: usize = 255;
const DEPTH_MAX: usize = 32;
const ENTRY_MAX: usize = 20_000;

#[derive(Debug)]
pub(super) enum Fault {
    Invalid(String),
    NotFound(String),
    Conflict(String),
    Internal(String),
}

fn invalid_path() -> Fault {
    Fault::Invalid("包内路径无效：只接受包根相对路径的名称段".into())
}

fn missing() -> Fault {
    Fault::NotFound("包内路径不存在".into())
}

fn internal(e: io::Error) -> Fault {
    Fault::Internal(format!("包文件操作失败：{e}"))
}

#[derive(Serialize)]
pub(super) struct Entry {
    pub path: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// 服务启动时准备包根目录。已存在的目录也要通过私有目录校验。
pub(super) fn prepare(dir: &Path) -> io::Result<()> {
    let base = dir.join(PACKAGES);
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&base)?;
    private(&base)?;
    for kind in ["work", "config"] {
        let path = base.join(kind);
        match DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        private(&path)?;
    }
    Ok(())
}

/// 私有目录：不是符号链接、是目录、组和其他账户无权限。
fn private(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || !meta.is_dir() || meta.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "包目录必须为服务账户私有且不是符号链接",
        ));
    }
    Ok(())
}

/// 每次操作前确认包根仍是私有目录，避免被换成分支链接。
pub(super) fn verify(root: &Path) -> Result<PathBuf, Fault> {
    private(root).map_err(|e| Fault::Internal(format!("包根不可用：{e}")))?;
    Ok(root.to_owned())
}

/// 把包根相对路径拆成名称段。空路径只在需要表示包根时接受。
pub(super) fn segments(path: &str, allow_root: bool) -> Result<Vec<String>, Fault> {
    if path.is_empty() {
        return if allow_root {
            Ok(Vec::new())
        } else {
            Err(invalid_path())
        };
    }
    if path.len() > PATH_MAX || path.starts_with('/') {
        return Err(invalid_path());
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() > DEPTH_MAX
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || part.starts_with(".workbench-tmp-")
                || part.len() > SEGMENT_MAX
                || part.chars().any(char::is_control)
        })
    {
        return Err(invalid_path());
    }
    Ok(parts.into_iter().map(str::to_owned).collect())
}

/// 逐级解析已存在的目录段。任意一级缺失、非目录或为符号链接都拒绝。
fn walk(root: &Path, parts: &[String]) -> Result<PathBuf, Fault> {
    let mut current = root.to_owned();
    for part in parts {
        current.push(part);
        let meta = fs::symlink_metadata(&current).map_err(|_| missing())?;
        if meta.file_type().is_symlink() {
            return Err(Fault::Internal("包内路径含有符号链接".into()));
        }
        if !meta.is_dir() {
            return Err(missing());
        }
    }
    Ok(current)
}

/// 校验父目录后把最后一个名称段交给操作。父目录缺失时不创建。
fn with_parent<T>(
    root: &Path,
    parts: &[String],
    f: impl FnOnce(&Path, &str) -> Result<T, Fault>,
) -> Result<T, Fault> {
    let (name, parents) = parts.split_last().ok_or_else(invalid_path)?;
    let dir = walk(root, parents)?;
    f(&dir, name)
}

fn sync(dir: &Path) -> Result<(), Fault> {
    File::open(dir).and_then(|d| d.sync_all()).map_err(internal)
}

/// 目标位置现状：`None` 表示不存在，`Some(true)` 表示普通文件，`Some(false)` 表示目录。
fn status(path: &Path) -> Result<Option<bool>, Fault> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(Fault::Internal("包内路径含有符号链接".into()))
        }
        Ok(meta) if meta.is_dir() => Ok(Some(false)),
        Ok(_) => Ok(Some(true)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(internal(e)),
    }
}

/// 全树扁平清单，路径为包根相对路径。符号链接和隐藏的中间文件不对外暴露。
pub(super) fn tree(root: &Path) -> Result<Vec<Entry>, Fault> {
    let root = verify(root)?;
    let mut entries = Vec::new();
    let mut pending = vec![(String::new(), root)];
    while let Some((prefix, dir)) = pending.pop() {
        for item in fs::read_dir(&dir).map_err(internal)? {
            let item = item.map_err(internal)?;
            let Ok(name) = item.file_name().into_string() else {
                continue;
            };
            if name.starts_with(".workbench-tmp-") {
                continue;
            }
            let path = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let meta = fs::symlink_metadata(item.path()).map_err(internal)?;
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                entries.push(Entry {
                    path: path.clone(),
                    kind: "dir",
                    size: None,
                });
                pending.push((path, item.path()));
            } else if meta.is_file() {
                entries.push(Entry {
                    path,
                    kind: "file",
                    size: Some(meta.len()),
                });
            }
            if entries.len() > ENTRY_MAX {
                return Err(Fault::Invalid("包内条目过多，无法列出".into()));
            }
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

pub(super) fn read(root: &Path, parts: &[String]) -> Result<Vec<u8>, Fault> {
    if parts.is_empty() {
        return Err(invalid_path());
    }
    let root = verify(root)?;
    let path = walk(&root, &parts[..parts.len() - 1])?.join(&parts[parts.len() - 1]);
    let meta = fs::symlink_metadata(&path).map_err(|_| missing())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(missing());
    }
    if meta.len() > FILE_LIMIT {
        return Err(Fault::Invalid("文件超过可读取大小上限".into()));
    }
    fs::read(&path).map_err(internal)
}

/// 写入文件。默认只新建，`replace` 为真时才覆盖已存在的文件。
pub(super) fn write(
    root: &Path,
    parts: &[String],
    bytes: &[u8],
    replace: bool,
) -> Result<(), Fault> {
    if bytes.len() as u64 > FILE_LIMIT {
        return Err(Fault::Invalid(format!(
            "单个文件最大 {} MiB",
            FILE_LIMIT / (1024 * 1024)
        )));
    }
    let root = verify(root)?;
    with_parent(&root, parts, |dir, name| {
        match status(&dir.join(name))? {
            Some(false) => return Err(Fault::Conflict(format!("{name} 是目录，不能写入文件"))),
            Some(true) if !replace => {
                return Err(Fault::Conflict(format!("{name} 已存在，覆盖需要显式确认")));
            }
            _ => {}
        }
        atomic(dir, name, bytes)
    })
}

/// 同目录临时文件写满并同步后 `rename` 到目标名，再同步目录项。
fn atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), Fault> {
    let tmp = dir.join(format!(".workbench-tmp-{}", Uuid::new_v4()));
    let publish = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(internal)?;
        file.write_all(bytes).map_err(internal)?;
        file.sync_all().map_err(internal)?;
        fs::rename(&tmp, dir.join(name)).map_err(internal)?;
        sync(dir)
    })();
    if publish.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    publish
}

pub(super) fn mkdir(root: &Path, parts: &[String]) -> Result<(), Fault> {
    let root = verify(root)?;
    with_parent(&root, parts, |dir, name| {
        let path = dir.join(name);
        if status(&path)?.is_some() {
            return Err(Fault::Conflict(format!("{name} 已存在")));
        }
        fs::create_dir(&path).map_err(internal)?;
        sync(dir)
    })
}

pub(super) fn remove(root: &Path, parts: &[String]) -> Result<(), Fault> {
    let root = verify(root)?;
    with_parent(&root, parts, |dir, name| {
        let path = dir.join(name);
        match status(&path)? {
            None => return Err(missing()),
            Some(true) => fs::remove_file(&path).map_err(internal)?,
            Some(false) => fs::remove_dir_all(&path).map_err(internal)?,
        }
        sync(dir)
    })
}

/// 移动或重命名包内条目，不覆盖目标。
pub(super) fn relocate(root: &Path, from: &[String], to: &[String]) -> Result<(), Fault> {
    let root = verify(root)?;
    with_parent(&root, from, |from_dir, from_name| {
        let source = from_dir.join(from_name);
        let directory = match status(&source)? {
            Some(is_file) => !is_file,
            None => return Err(missing()),
        };
        with_parent(&root, to, |to_dir, to_name| {
            if directory && to.starts_with(from) {
                return Err(Fault::Invalid("不能把目录移动到自身内部".into()));
            }
            let target = to_dir.join(to_name);
            if status(&target)?.is_some() {
                return Err(Fault::Conflict("目标位置已存在，移动不覆盖".into()));
            }
            fs::rename(&source, &target).map_err(internal)?;
            sync(from_dir)?;
            if to_dir != from_dir {
                sync(to_dir)?;
            }
            Ok(())
        })
    })
}
