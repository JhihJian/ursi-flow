//! 稳定内容存储：内容寻址的文件存储，保证完整发布与路径边界。
//!
//! 内容标识 = sha256(bytes) 的完整 64 位小写 hex 字符串，内容寻址天然幂等：
//! 同一字节序列重复写入得到同一 id。写入先落唯一临时文件再原子重命名发布，
//! 中断不会发布半份内容；对象按 sha256 前缀分两级目录存放。
//!
//! 路径边界：拒绝绝对路径、`..` 穿越和逐组件符号链接逃逸，错误信息只含
//! 非法路径本身，不泄漏根目录外的真实目标。读取与删除按 id 走固定层级，
//! id 必须是 hex 形式，同样无法构造路径逃逸。
//!
//! 引用语义：本模块只负责内容字节，不持有引用表。各业务域在数据库事务内
//! 保存 `content_id` 引用；引用提交失败遗留的未引用内容由
//! [`ContentStore::sweep_unreferenced`] 按写入时间清理。

use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

/// 内容存储错误。
#[derive(Debug, thiserror::Error)]
pub enum ContentError {
    #[error("非法内容路径：{0}")]
    InvalidPath(String),
    #[error("内容不存在：{0}")]
    NotFound(String),
    #[error("内容存储错误：{0}")]
    Io(String),
}

/// 稳定内容存储。`root` 目录内按 sha256 前缀分两级目录存放对象。
pub struct ContentStore {
    root: PathBuf,
}

impl ContentStore {
    /// 在指定根目录上打开内容存储，目录按需创建。
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, ContentError> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|e| ContentError::Io(e.to_string()))?;
        Ok(Self { root })
    }

    /// 写入内容，返回稳定内容标识（sha256 完整 hex，64 字符小写）。
    ///
    /// 同内容幂等：重复写入同一字节序列返回同一 id 且不产生重复对象。
    /// 先写临时文件再原子重命名发布，中断只会遗留临时文件，不发布半份内容。
    ///
    /// `path_in_root` 目前仅用于边界校验（为按名内容预留的入口签名），
    /// 对象实际按内容 id 存放，同 id 只有一份字节。
    pub fn write(&self, path_in_root: &str, bytes: &[u8]) -> Result<String, ContentError> {
        // 边界校验先行：非法请求不落任何盘上内容。
        self.resolve(path_in_root)?;

        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let id = hex::encode(hasher.finalize());

        // 同内容幂等：已存在直接返回 id（内容寻址，同 id 必同字节）。
        let final_path = self.object_path(&id)?;
        if final_path.exists() {
            return Ok(id);
        }

        // 唯一临时文件与对象同目录（同文件系统），rename 原子发布。
        let tmp = NamedTempFileIn::create(&self.root)?;
        let write_result = (|| -> std::io::Result<()> {
            let mut file = fs::File::create(tmp.path())?;
            file.write_all(bytes)?;
            file.flush()?;
            file.sync_all()?;
            Ok(())
        })();
        if let Err(e) = write_result {
            let _ = fs::remove_file(tmp.path());
            return Err(ContentError::Io(e.to_string()));
        }
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent).map_err(|e| ContentError::Io(e.to_string()))?;
        }
        // persist 内部把“目标已存在”视为成功（内容寻址幂等），并发同内容写入收敛为同一对象。
        tmp.persist(&final_path)?;
        Ok(id)
    }

    /// 按内容标识读取完整字节。id 必须是 sha256 hex 形式，防止拼接路径逃逸。
    pub fn read(&self, content_id: &str) -> Result<Vec<u8>, ContentError> {
        let path = self.object_path(content_id)?;
        // 不按调用方的逻辑路径打开文件。对象根、分片目录和对象本身
        // 都应是存储创建的实体，尤其不能经有效的 hash 名跟随符号链接。
        for dir in [&self.root, &self.root.join(&content_id[..2])] {
            let meta = fs::symlink_metadata(dir).map_err(|e| map_read_delete_err(e, content_id))?;
            if !meta.is_dir() {
                return Err(ContentError::InvalidPath(content_id.to_string()));
            }
        }
        let meta = fs::symlink_metadata(&path).map_err(|e| map_read_delete_err(e, content_id))?;
        if !meta.is_file() {
            return Err(ContentError::InvalidPath(content_id.to_string()));
        }
        fs::read(&path).map_err(|e| map_read_delete_err(e, content_id))
    }

    /// 删除一个内容对象（不校验引用，调用方先确认无引用）。
    pub fn delete(&self, content_id: &str) -> Result<(), ContentError> {
        let path = self.object_path(content_id)?;
        fs::remove_file(&path).map_err(|e| map_read_delete_err(e, content_id))
    }

    /// 对象真实路径：id 仅允许 sha256 hex 字符，落地在根目录固定两级层级内。
    pub(crate) fn object_path(&self, content_id: &str) -> Result<PathBuf, ContentError> {
        let valid = content_id.len() == 64
            && content_id
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        if !valid {
            return Err(ContentError::InvalidPath(content_id.to_string()));
        }
        Ok(self.root.join(&content_id[..2]).join(content_id))
    }

    /// 校验 `path_in_root` 的边界并返回其应处的根内路径。
    ///
    /// 规则：必须是非空相对路径，组件只允许普通段（`.` 视为噪音跳过），
    /// `..` 直接拒绝；逐组件要求任何已存在的部分都不是符号链接，
    /// 从而杜绝“根目录内 symlink 指向根外”的逃逸。
    fn resolve(&self, path_in_root: &str) -> Result<PathBuf, ContentError> {
        if path_in_root.is_empty() {
            return Err(ContentError::InvalidPath(path_in_root.to_string()));
        }
        let path = Path::new(path_in_root);
        if path.is_absolute() {
            return Err(ContentError::InvalidPath(path_in_root.to_string()));
        }
        let mut current = self.root.clone();
        for component in path.components() {
            match component {
                Component::Normal(seg) => {
                    current = current.join(seg);
                    // symlink_metadata 不跟随链接：存在且是链接即拒绝。
                    if let Ok(meta) = fs::symlink_metadata(&current) {
                        if meta.file_type().is_symlink() {
                            return Err(ContentError::InvalidPath(path_in_root.to_string()));
                        }
                    }
                }
                Component::ParentDir => {
                    return Err(ContentError::InvalidPath(path_in_root.to_string()));
                }
                Component::CurDir => {}
                Component::RootDir | Component::Prefix(_) => {
                    // is_absolute 已覆盖 RootDir；Prefix 仅 Windows，防御性拒绝。
                    return Err(ContentError::InvalidPath(path_in_root.to_string()));
                }
            }
        }
        Ok(current)
    }

    /// 清理未引用内容：删除写入时间早于 `older_than` 且不在 `keep` 列表中的对象。
    ///
    /// 返回被删除的 id 列表。调用方把已提交的引用传入 `keep`，或先于清理
    /// 完成引用登记；刚写入、引用事务未提交的内容因 mtime 较新被保留。
    /// 写入中断遗留的临时文件一并清理（不记入返回值）。
    pub fn sweep_unreferenced(
        &self,
        keep: &[String],
        older_than: Duration,
    ) -> Result<Vec<String>, ContentError> {
        let cutoff = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|e| ContentError::Io(e.to_string()))?
            .saturating_sub(older_than);
        let mut removed = Vec::new();
        let mut scan_dir = |dir: &Path| -> Result<(), ContentError> {
            let Ok(entries) = fs::read_dir(dir) else {
                return Ok(());
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                let is_object = name.len() == 64
                    && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
                if is_object && keep.iter().any(|k| k == name) {
                    continue;
                }
                let fresh = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .is_some_and(|t| t > cutoff);
                if fresh {
                    continue;
                }
                if fs::remove_file(&path).is_ok() && is_object {
                    removed.push(name.to_string());
                }
            }
            Ok(())
        };
        scan_dir(&self.root)?;
        for entry in fs::read_dir(&self.root)
            .map_err(|e| ContentError::Io(e.to_string()))?
            .flatten()
        {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                scan_dir(&entry.path())?;
            }
        }
        Ok(removed)
    }
}

/// 同目录唯一临时文件：随机名，不跟随任何调用方路径。
struct NamedTempFileIn {
    path: PathBuf,
}

impl NamedTempFileIn {
    fn create(dir: &Path) -> Result<Self, ContentError> {
        // 临时名以 .tmp 结尾，不是 64 hex，sweep 按遗留临时文件清理。
        for _ in 0..8 {
            let name = format!(".{}.tmp", uuid::Uuid::new_v4().simple());
            let path = dir.join(&name);
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Ok(Self { path }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(ContentError::Io(e.to_string())),
            }
        }
        Err(ContentError::Io("生成临时文件名失败".to_string()))
    }

    fn path(&self) -> &Path {
        &self.path
    }

    /// 原子发布：rename 到目标；目标已存在时视为成功（内容寻址幂等）。
    fn persist(self, target: &Path) -> Result<(), ContentError> {
        if target.exists() {
            let _ = fs::remove_file(&self.path);
            return Ok(());
        }
        match fs::rename(&self.path, target) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = fs::remove_file(&self.path);
                Err(ContentError::Io(e.to_string()))
            }
        }
    }
}

fn map_read_delete_err(e: std::io::Error, content_id: &str) -> ContentError {
    match e.kind() {
        std::io::ErrorKind::NotFound => ContentError::NotFound(content_id.to_string()),
        _ => ContentError::Io(e.to_string()),
    }
}

#[cfg(test)]
impl ContentStore {
    /// 测试专用：按 id 取对象盘上路径（只读，不产生写操作）。
    pub fn test_object_path(&self, content_id: &str) -> PathBuf {
        self.object_path(content_id).expect("测试用合法 id")
    }
}
