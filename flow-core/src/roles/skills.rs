//! Skills 完整文件包：入口文件 + 任意相对路径文件集合。
//!
//! 模型：
//! - [`SkillFile`]：包内一个文件（相对路径 + 字节内容）；
//! - [`SkillPackage`]：文件集合 + 入口路径。内容随角色持久化，读回逐文件字节一致。
//!
//! 路径规则（写入前校验，非法输入不落任何内容）：
//! - 必须是非空相对路径，分隔符统一为 `/`；
//! - 绝对路径、空段、`.`、`..` 一律拒绝；
//! - 重复路径拒绝；
//! - 入口文件必须存在于包内；
//! - symlink 逃逸由内容存储逐组件拦截（见 [`crate::storage::ContentStore`]）。
//!
//! 一致性：先写全部内容字节到内容存储（内容寻址，天然幂等），再在同一
//! SQLite 事务内提交角色文件元数据；事务失败已写字节成为未引用内容，由
//! `ContentStore::sweep_unreferenced` 清理，不会出现半包可见状态。

use serde::{Deserialize, Serialize};

use super::error::{RoleValidationError, RolesError};

/// Skills 入口文件的约定路径。
pub const SKILL_ENTRY: &str = "SKILL.md";

/// 包内一个文件：相对路径 + 字节内容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillFile {
    /// 包内相对路径，`/` 分隔（如 `scripts/run.sh`）。
    pub path: String,
    /// 完整字节内容。
    pub bytes: Vec<u8>,
}

impl SkillFile {
    pub fn new(path: impl Into<String>, bytes: impl Into<Vec<u8>>) -> Self {
        Self { path: path.into(), bytes: bytes.into() }
    }
}

/// 校验包内相对路径的边界。返回规范化路径（原样，仅校验）。
///
/// 规则：非空；不含 `\`；按 `/` 分段后每段必须是普通非空段；
/// 拒绝绝对路径、`.`、`..`；路径不含 NUL 字节。
pub fn validate_skill_path(path: &str) -> Result<(), RoleValidationError> {
    let invalid = || RoleValidationError::SkillPath(path.to_string());
    if path.is_empty() || path.contains('\\') || path.contains('\0') {
        return Err(invalid());
    }
    if path.starts_with('/') {
        return Err(invalid());
    }
    for seg in path.split('/') {
        // 空段（`a//b`、尾随 `/`）、当前段与父段全部拒绝。
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(invalid());
        }
    }
    Ok(())
}

/// Skills 完整文件包。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillPackage {
    /// 入口文件路径（缺省 `SKILL.md`）。
    pub entry: String,
    /// 包内全部文件（含入口）。
    pub files: Vec<SkillFile>,
}

impl SkillPackage {
    /// 以 `SKILL.md` 为入口创建文件包并立即校验结构。
    /// 校验失败返回错误，不产生任何持久化副作用。
    pub fn new(files: Vec<SkillFile>) -> Result<Self, RoleValidationError> {
        Self::with_entry(SKILL_ENTRY, files)
    }

    /// 角色 DTO 与存储共用的解码规则。仅 Runtime 固定 profile 不携带文件包。
    pub(crate) fn for_executor(
        kind: Option<&crate::domain::ExecutorKind>,
        entry: &str,
        files: Vec<SkillFile>,
    ) -> Result<Self, RoleValidationError> {
        if kind.map(|k| k.as_str()) == Some(super::RUNTIME_ACP) && files.is_empty() {
            validate_skill_path(entry)?;
            Ok(Self { entry: entry.into(), files })
        } else {
            Self::with_entry(entry, files)
        }
    }

    /// 指定入口创建文件包并校验：路径边界、重复路径、入口存在。
    pub fn with_entry(entry: impl Into<String>, mut files: Vec<SkillFile>) -> Result<Self, RoleValidationError> {
        let entry = entry.into();
        validate_skill_path(&entry)?;
        let mut seen = std::collections::BTreeSet::new();
        for f in &files {
            validate_skill_path(&f.path)?;
            if !seen.insert(f.path.as_str()) {
                return Err(RoleValidationError::SkillDuplicate(f.path.clone()));
            }
        }
        if !seen.contains(entry.as_str()) {
            return Err(RoleValidationError::SkillMissingEntry(entry));
        }
        // 规范化：按路径排序存储，等价性与保存顺序无关。
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(Self { entry, files })
    }

    /// 按路径读取包内文件内容（交付与快照使用）。
    pub fn file(&self, path: &str) -> Option<&SkillFile> {
        self.files.iter().find(|f| f.path == path)
    }
}

/// 从磁盘目录读取文件包（角色复制与迁移用）：递归读取全部普通文件，
/// 相对路径以 `/` 分隔。遇到符号链接即拒绝（不跟随），防止逃逸内容进入包。
pub fn read_package_from_dir(root: &std::path::Path, entry: &str) -> Result<SkillPackage, RolesError> {
    let mut files = Vec::new();
    collect_files(root, root, &mut files)?;
    SkillPackage::with_entry(entry, files).map_err(RolesError::from)
}

fn collect_files(
    root: &std::path::Path,
    dir: &std::path::Path,
    out: &mut Vec<SkillFile>,
) -> Result<(), RolesError> {
    let entries = std::fs::read_dir(dir).map_err(|e| RolesError::Storage(e.to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|e| RolesError::Storage(e.to_string()))?;
        let path = entry.path();
        // symlink_metadata 不跟随链接：目录树内出现任何链接即拒绝。
        let meta = std::fs::symlink_metadata(&path).map_err(|e| RolesError::Storage(e.to_string()))?;
        let rel = path
            .strip_prefix(root)
            .expect("read_dir 返回的路径必在 root 下")
            .to_string_lossy()
            .to_string();
        if meta.file_type().is_symlink() {
            return Err(RoleValidationError::SkillPath(rel).into());
        }
        if meta.is_dir() {
            collect_files(root, &path, out)?;
        } else if meta.is_file() {
            let bytes = std::fs::read(&path).map_err(|e| RolesError::Storage(e.to_string()))?;
            out.push(SkillFile::new(rel, bytes));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SPEC「Skills 完整文件包与 MCP 配置」：合法包结构校验通过，
    /// file() 按路径取回内容。
    #[test]
    fn 合法包通过校验且可按路径取文件() {
        let pkg = SkillPackage::new(vec![
            SkillFile::new("SKILL.md", "# 入口说明"),
            SkillFile::new("scripts/run.sh", "#!/bin/sh\necho hi"),
            SkillFile::new("assets/模板.txt", "模板内容"),
        ])
        .unwrap();
        assert_eq!(pkg.entry, SKILL_ENTRY);
        assert_eq!(pkg.file("scripts/run.sh").unwrap().bytes, b"#!/bin/sh\necho hi");
        assert!(pkg.file("不存在").is_none());
    }

    /// SPEC「Skills 完整文件包与 MCP 配置」：缺入口、重复路径、绝对路径、
    /// `..` 穿越、反斜杠与空段全部拒绝，且错误信息只含包内相对路径。
    #[test]
    fn 非法包结构被拒绝() {
        let f = |p: &str| SkillFile::new(p, "x");
        assert!(matches!(
            SkillPackage::new(vec![f("README.md")]),
            Err(RoleValidationError::SkillMissingEntry(e)) if e == SKILL_ENTRY
        ));
        assert!(matches!(
            SkillPackage::new(vec![f("SKILL.md"), f("a.txt"), f("a.txt")]),
            Err(RoleValidationError::SkillDuplicate(e)) if e == "a.txt"
        ));
        assert!(matches!(
            SkillPackage::new(vec![f("SKILL.md"), f("/etc/passwd")]),
            Err(RoleValidationError::SkillPath(e)) if e == "/etc/passwd"
        ));
        for bad in ["../escape", "a/../../b", "a//b", "a/", "./SKILL.md", "a\\b", ""] {
            assert!(
                SkillPackage::new(vec![f("SKILL.md"), f(bad)]).is_err(),
                "路径 {bad:?} 必须被拒绝"
            );
        }
        // 目录穿越错误只回显包内相对路径本身。
        let err = SkillPackage::new(vec![f("SKILL.md"), f("../secret")]).unwrap_err();
        assert_eq!(err.to_string(), "skills 路径非法：../secret");
    }

    /// SPEC「Skills 完整文件包与 MCP 配置」：从磁盘目录读包，递归保留
    /// 嵌套结构；目录树内的符号链接被拒绝。
    #[test]
    fn 从目录读包保留嵌套且拒绝链接() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("scripts")).unwrap();
        std::fs::write(dir.path().join("SKILL.md"), "# 说明").unwrap();
        std::fs::write(dir.path().join("scripts/run.sh"), "echo ok").unwrap();
        let pkg = read_package_from_dir(dir.path(), SKILL_ENTRY).unwrap();
        assert_eq!(pkg.file("scripts/run.sh").unwrap().bytes, b"echo ok");

        // 根目录内链接指向根外：读包拒绝，不跟随。
        std::os::unix::fs::symlink("/etc/passwd", dir.path().join("evil")).unwrap();
        assert!(matches!(
            read_package_from_dir(dir.path(), SKILL_ENTRY),
            Err(RolesError::Validation(RoleValidationError::SkillPath(_)))
        ));
    }
}
