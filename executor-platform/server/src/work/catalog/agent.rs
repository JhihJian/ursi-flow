//! Agent 草稿与发布共用只读解析，快照只含运行所需的固定正文和命名引用。
use super::{
    Error, Reply,
    definitions::{fields, id, name, text},
    policy,
};
use crate::work::{
    directories::{self, fs},
    patches,
};
use axum::Json;
use base64::{Engine, engine::general_purpose::STANDARD};
use rustix::{
    fd::{AsRawFd, OwnedFd},
    fs::{self as at, Dir, FileType, Mode, OFlags, ResolveFlags},
    io::Errno,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs::File, io::Read, path::Path};

pub(super) async fn options() -> Reply {
    let policy = policy::load()?;
    Ok(Json(json!({
        "models": policy.models.iter().map(|id| json!({"id":id})).collect::<Vec<_>>(),
        "tools": policy.tools.keys().map(|id| json!({"id":id})).collect::<Vec<_>>(),
    })))
}

pub(in crate::work) const SNAPSHOT_LIMIT: usize = 2 * 1024 * 1024;
const SKILL_ENTRY_LIMIT: usize = 4096;
const DIRECTORY: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::CLOEXEC);
const WITHIN: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_XDEV);

fn document(root: &Path, path: &str) -> Result<Vec<u8>, Error> {
    fs::read(root, &fs::segments(path, false)?).map_err(|e| match e {
        fs::Fault::NotFound(_) => Error::Invalid(format!("配置包缺少普通文件 {path}")),
        _ => e.into(),
    })
}

fn markdown(root: &Path, path: &str) -> Result<String, Error> {
    let bytes = document(root, path)?;
    let content = String::from_utf8(bytes)
        .map_err(|_| Error::Invalid(format!("{path} 必须是 UTF-8 正文")))?;
    if content.trim().is_empty() || content.len() > 256 * 1024 {
        return Err(Error::Invalid(format!("{path} 需要非空正文，最多 256 KiB")));
    }
    Ok(content)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillFile {
    path: String,
    content_base64: String,
    sha256: String,
}

struct SnapshotBudget {
    remaining: usize,
    entries: usize,
}

impl SnapshotBudget {
    fn charge(&mut self, bytes: usize) -> Result<(), Error> {
        self.remaining = self.remaining.checked_sub(bytes).ok_or_else(too_large)?;
        Ok(())
    }

    fn collect_files(
        &mut self,
        dir: &OwnedFd,
        skill_root: &str,
        prefix: &str,
        files: &mut Vec<SkillFile>,
    ) -> Result<(), Error> {
        for entry in Dir::read_from(dir).map_err(skill_open_error)? {
            let entry = entry.map_err(skill_open_error)?;
            let name = entry.file_name();
            if matches!(name.to_bytes(), b"." | b"..") {
                continue;
            }
            self.entries += 1;
            if self.entries > SKILL_ENTRY_LIMIT {
                return Err(Error::Invalid("Skill 目录条目最多 4096 个".into()));
            }
            if name.to_bytes().starts_with(b".workbench-tmp-")
                || (prefix.is_empty() && name.to_bytes() == b"SKILL.md")
            {
                continue;
            }
            let name = name
                .to_str()
                .map_err(|_| Error::Invalid("Skill 路径必须是 UTF-8".into()))?;
            let path = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            fs::segments(&format!("{skill_root}/{path}"), false)?;
            // 先固定 inode，再检查类型，避免打开设备或阻塞在 FIFO 上。
            let pin = at::openat2(
                dir,
                name,
                OFlags::PATH | OFlags::CLOEXEC,
                Mode::empty(),
                WITHIN,
            )
            .map_err(skill_open_error)?;
            let stat = at::fstat(&pin).map_err(skill_open_error)?;
            match FileType::from_raw_mode(stat.st_mode) {
                FileType::Directory => {
                    let child = at::openat2(&pin, ".", DIRECTORY, Mode::empty(), WITHIN)
                        .map_err(skill_open_error)?;
                    self.collect_files(&child, skill_root, &path, files)?;
                }
                FileType::RegularFile if stat.st_nlink == 1 => {
                    // 先按 Base64 长度预算原始字节，最终再检查完整 JSON 大小。
                    self.charge(path.len() + 64)?;
                    let limit = (self.remaining / 4 * 3) as u64;
                    let size = stat.st_size as u64;
                    if size > limit {
                        return Err(too_large());
                    }
                    let mut bytes = Vec::new();
                    File::open(format!("/proc/self/fd/{}", pin.as_raw_fd()))
                        .and_then(|file| file.take(size + 1).read_to_end(&mut bytes))
                        .map_err(|e| Error::Internal(format!("读取 Skill 附件失败：{e}")))?;
                    let after = at::fstat(&pin).map_err(skill_open_error)?;
                    if bytes.len() as u64 != size
                        || after.st_nlink != 1
                        || (after.st_ctime, after.st_ctime_nsec)
                            != (stat.st_ctime, stat.st_ctime_nsec)
                    {
                        return Err(Error::Invalid("快照读取期间 Skill 附件有变动".into()));
                    }
                    let content_base64 = STANDARD.encode(&bytes);
                    self.charge(content_base64.len())?;
                    files.push(SkillFile {
                        path,
                        content_base64,
                        sha256: format!("{:x}", Sha256::digest(&bytes)),
                    });
                }
                _ => return Err(Error::Invalid("Skill 只接受目录和独立普通文件".into())),
            }
        }
        Ok(())
    }
}

fn skill_open_error(error: Errno) -> Error {
    match error {
        Errno::LOOP | Errno::XDEV => Error::Invalid("Skill 路径不能包含链接或跨挂载点".into()),
        _ => Error::Internal(format!("读取 Skill 目录失败：{error}")),
    }
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct Settings {
    #[serde(deserialize_with = "model_id")]
    model_profile: Option<String>,
    tools: Vec<String>,
    mcp_servers: Map<String, Value>,
}

// Only omission selects the default model. An explicit null is not a model ID.
fn model_id<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}

fn selection(config: Settings, policy: &policy::Policy) -> Result<(String, Vec<Value>), Error> {
    if !config.mcp_servers.is_empty() {
        return Err(Error::Invalid(
            "Agent 不支持非空 mcpServers，请在 tools 中引用管理员授权的工具 ID".into(),
        ));
    }
    let model = match config.model_profile.as_deref() {
        Some(id) => name(id)?,
        None => policy
            .models
            .first()
            .ok_or_else(|| Error::Invalid("管理员策略没有可用模型".into()))?,
    };
    if !policy.models.iter().any(|id| id == model) {
        return Err(Error::Invalid("模型未获管理员授权".into()));
    }
    let mut tools = Vec::new();
    if config.tools.len() > 64 {
        return Err(Error::Invalid("工具最多 64 个".into()));
    }
    let mut seen = BTreeSet::new();
    for tool in &config.tools {
        let id = name(tool)?;
        let digest = policy
            .tools
            .get(id)
            .ok_or_else(|| Error::Invalid("工具未获管理员授权".into()))?;
        if !seen.insert(id) {
            return Err(Error::Invalid("工具标识不能重复".into()));
        }
        tools.push(json!({"id":id,"schemaDigest":digest}));
    }
    Ok((model.to_owned(), tools))
}

/// 调用方持有 Store 锁，与目录 API 的写操作互斥，直到整份快照解析完毕。
pub(super) fn preview(store_dir: &Path, db: &Value, definition: &Value) -> Result<Value, Error> {
    fields(definition, &["id", "agent"])?;
    id(definition)?;
    let agent = &definition["agent"];
    fields(agent, &["configPackageId", "backendId"])?;
    if agent.get("backendId").is_some() {
        name(text(agent, "backendId")?)?;
    }
    let package = name(text(agent, "configPackageId")?)?;
    let directory = patches::config_package_directory(db, package)?;
    let root = directories::registered_root(store_dir, db, &directory)?;
    let bytes = document(&root, "mcp.json")?;
    // Serde also accepts positional arrays for structs; this contract is object-only.
    if bytes.trim_ascii_start().first() != Some(&b'{') {
        return Err(Error::Invalid("mcp.json 顶层必须是对象".into()));
    }
    let config = serde_json::from_slice(&bytes).map_err(|_| {
        Error::Invalid(
            "mcp.json 只接受含可选 modelProfile、tools 与空 mcpServers 对象的配置".into(),
        )
    })?;
    let (model, tools) = selection(config, &policy::load()?)?;
    let prompt = markdown(&root, "AGENTS.md")?;
    let names = fs::child_dirs(&root, &["skills".into()])?;
    if names.len() > 64 {
        return Err(Error::Invalid("Skill 最多 64 个".into()));
    }
    let package_dir = at::openat2(
        at::CWD,
        &root,
        DIRECTORY,
        Mode::empty(),
        ResolveFlags::NO_SYMLINKS,
    )
    .map_err(skill_open_error)?;
    let mut skills = Vec::new();
    let mut budget = SnapshotBudget {
        remaining: SNAPSHOT_LIMIT - prompt.len(),
        entries: 0,
    };
    for skill in names {
        name(&skill)?;
        let skill_root = format!("skills/{skill}");
        let dir = at::openat2(
            &package_dir,
            skill_root.as_str(),
            DIRECTORY,
            Mode::empty(),
            WITHIN,
        )
        .map_err(skill_open_error)?;
        let content = markdown(&root, &format!("{skill_root}/SKILL.md"))?;
        budget.charge(content.len())?;
        let mut files = Vec::new();
        budget.collect_files(&dir, &skill_root, "", &mut files)?;
        files.sort_unstable_by(|left, right| left.path.cmp(&right.path));
        // 包文件无资源修订号；在每份独立快照内嵌为第 1 版。
        let mut snapshot = json!({"id":skill,"revision":1,"content":content});
        if !files.is_empty() {
            snapshot["files"] = json!(files);
        }
        skills.push(snapshot);
    }
    let snapshot =
        json!({"systemPrompt":prompt,"modelProfile":model,"skills":skills,"tools":tools});
    if snapshot.to_string().len() > SNAPSHOT_LIMIT {
        return Err(too_large());
    }
    Ok(snapshot)
}

fn too_large() -> Error {
    Error::Invalid("Agent 快照超过 2 MiB".into())
}
