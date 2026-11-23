//! 管理员维护的 SSH 授权公钥。只保存公开公钥，不保存任何私钥或秘密。
//!
//! 每个 profile 的密钥集渲染为 `<存储路径>.d/<profile>/authorized_keys`，
//! 由 Docker 驱动以只读单文件挂载覆盖 `/run/ursi/config/authorized_keys`。
//! 渲染文件一旦创建永不删除，因为 Docker 对缺失的 bind 源直接拒绝启动。
use crate::models::{Error, Result, valid_name};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

/// 单条公钥最多 4 KiB，单个 profile 最多 64 条。
const MAX_KEY_BYTES: usize = 4096;
const MAX_KEYS: usize = 64;
const MAX_FILE_BYTES: usize = 64 * 1024;
const KEY_TYPES: &[&str] = &[
    "ssh-ed25519",
    "ssh-rsa",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessKey {
    pub key: String,
    pub fingerprint: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileAccess {
    pub profile: String,
    pub rendered_at: Option<u64>,
    pub keys: Vec<AccessKey>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Document {
    #[serde(default)]
    profiles: BTreeMap<String, Vec<AccessKey>>,
}

pub struct AccessKeys {
    path: PathBuf,
    root: PathBuf,
}

impl AccessKeys {
    pub fn open(path: &Path) -> Result<Self> {
        let root = render_root(path)?;
        fs::create_dir_all(&root).map_err(|_| Error::Unavailable("授权目录不可创建".into()))?;
        let store = Self {
            path: path.to_owned(),
            root,
        };
        // 启动时校验既有内容，损坏的文件不应带着错误内容进入渲染。
        store.document()?;
        Ok(store)
    }

    fn document(&self) -> Result<Document> {
        match fs::read(&self.path) {
            Ok(data) if data.len() > MAX_FILE_BYTES => {
                Err(Error::Invalid("授权记录文件过大".into()))
            }
            Ok(data) => serde_json::from_slice(&data)
                .map_err(|_| Error::Invalid("授权记录文件格式错误".into())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Document::default()),
            Err(_) => Err(Error::Unavailable("授权记录文件不可读取".into())),
        }
    }

    fn save(&self, document: &Document) -> Result<()> {
        let content = serde_json::to_vec_pretty(document)
            .map_err(|error| Error::Internal(error.to_string()))?;
        let temporary = self.path.with_extension("json.tmp");
        fs::write(&temporary, content)
            .map_err(|_| Error::Unavailable("授权记录不可写入".into()))?;
        fs::rename(&temporary, &self.path)
            .map_err(|_| Error::Unavailable("授权记录不可写入".into()))?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<ProfileAccess>> {
        let document = self.document()?;
        Ok(document
            .profiles
            .into_iter()
            .map(|(profile, keys)| ProfileAccess {
                rendered_at: rendered_at(&self.rendered(&profile)),
                profile,
                keys,
            })
            .collect())
    }

    /// 新增公钥并立即重写该 profile 的渲染文件。重复指纹视为已存在。
    pub fn add(&self, profile: &str, raw: &str) -> Result<AccessKey> {
        check_profile(profile)?;
        let (key, fingerprint) = normalize_key(raw)?;
        let mut document = self.document()?;
        let keys = document.profiles.entry(profile.to_owned()).or_default();
        if let Some(existing) = keys.iter().find(|item| item.fingerprint == fingerprint) {
            return Ok(existing.clone());
        }
        if keys.len() >= MAX_KEYS {
            return Err(Error::Invalid("单个 profile 的授权公钥过多".into()));
        }
        let entry = AccessKey {
            key,
            fingerprint,
            created_at: now_seconds(),
        };
        keys.push(entry.clone());
        self.save(&document)?;
        self.render(profile, &document)?;
        Ok(entry)
    }

    /// 删除公钥。拒绝删到零条，空集合会让该 profile 下所有沙箱无法启动。
    pub fn remove(&self, profile: &str, fingerprint: &str) -> Result<()> {
        check_profile(profile)?;
        let mut document = self.document()?;
        let keys = document
            .profiles
            .get_mut(profile)
            .ok_or_else(|| Error::NotFound("该 profile 没有授权公钥".into()))?;
        let before = keys.len();
        keys.retain(|item| item.fingerprint != fingerprint);
        if keys.len() == before {
            return Err(Error::NotFound("公钥不存在".into()));
        }
        if keys.is_empty() {
            return Err(Error::Conflict(
                "不能删除最后一个公钥；空授权会让该 profile 的沙箱无法启动".into(),
            ));
        }
        self.save(&document)?;
        self.render(profile, &document)?;
        Ok(())
    }

    /// 驱动创建容器时使用的渲染文件。未登记密钥的 profile 不产生覆盖挂载。
    pub fn rendered(&self, profile: &str) -> Option<PathBuf> {
        let path = self.root.join(profile).join("authorized_keys");
        path.is_file().then_some(path)
    }

    pub fn render_root(&self) -> &Path {
        &self.root
    }

    fn render(&self, profile: &str, document: &Document) -> Result<()> {
        let Some(keys) = document.profiles.get(profile) else {
            return Ok(());
        };
        if keys.is_empty() {
            return Err(Error::Conflict("拒绝渲染空授权集合".into()));
        }
        let directory = self.root.join(profile);
        fs::create_dir_all(&directory)
            .map_err(|_| Error::Unavailable("授权目录不可创建".into()))?;
        let mut content = String::new();
        for key in keys {
            content.push_str(&key.key);
            content.push('\n');
        }
        // 同目录写临时文件再重命名，避免容器启动时读到半截内容。
        let target = directory.join("authorized_keys");
        let temporary = directory.join("authorized_keys.tmp");
        fs::write(&temporary, content)
            .map_err(|_| Error::Unavailable("授权文件不可写入".into()))?;
        fs::rename(&temporary, &target)
            .map_err(|_| Error::Unavailable("授权文件不可写入".into()))?;
        Ok(())
    }
}

fn check_profile(profile: &str) -> Result<()> {
    if !valid_name(profile) {
        return Err(Error::Invalid("profile 名称无效".into()));
    }
    Ok(())
}

/// 只接受 `type base64 [comment]` 三段式，拒绝 authorized_keys 选项前缀。
pub fn normalize_key(raw: &str) -> Result<(String, String)> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_KEY_BYTES {
        return Err(Error::Invalid("公钥长度非法".into()));
    }
    if raw
        .chars()
        .any(|c| c.is_control() || c == '\n' || c == '\r')
    {
        return Err(Error::Invalid("公钥不能包含控制字符或多行".into()));
    }
    let mut parts = raw.split_whitespace();
    let kind = parts
        .next()
        .ok_or_else(|| Error::Invalid("公钥缺少类型".into()))?;
    if !KEY_TYPES.contains(&kind) {
        return Err(Error::Invalid(
            "不支持的密钥类型，或包含 authorized_keys 选项前缀".into(),
        ));
    }
    let blob = parts
        .next()
        .ok_or_else(|| Error::Invalid("公钥缺少内容".into()))?;
    if blob.is_empty() || blob.len() > MAX_KEY_BYTES || !is_base64(blob) {
        return Err(Error::Invalid("公钥内容不是有效的 base64".into()));
    }
    let comment = parts.collect::<Vec<_>>().join(" ");
    if comment.len() > 256 {
        return Err(Error::Invalid("公钥备注过长".into()));
    }
    let key = if comment.is_empty() {
        format!("{kind} {blob}")
    } else {
        format!("{kind} {blob} {comment}")
    };
    Ok((key, fingerprint(blob)))
}

fn is_base64(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

/// OpenSSH 风格指纹：`SHA256:` 加解码后密钥 blob 的 SHA-256 的 base64 无填充形式。
fn fingerprint(blob: &str) -> String {
    use sha2::{Digest, Sha256};
    let decoded = decode_base64(blob).unwrap_or_default();
    let digest = Sha256::digest(&decoded);
    format!("SHA256:{}", encode_base64(&digest))
}

fn decode_base64(value: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255u8; 256];
    for (index, byte) in TABLE.iter().enumerate() {
        lookup[*byte as usize] = index as u8;
    }
    let mut output = Vec::new();
    let mut accumulator = 0u32;
    let mut bits = 0u32;
    for byte in value.bytes() {
        if byte == b'=' {
            break;
        }
        let digit = lookup[byte as usize];
        if digit == 255 {
            return None;
        }
        accumulator = (accumulator << 6) | digit as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((accumulator >> bits) as u8);
        }
    }
    Some(output)
}

fn encode_base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    for chunk in data.chunks(3) {
        let mut buffer = [0u8; 3];
        buffer[..chunk.len()].copy_from_slice(chunk);
        let value = u32::from(buffer[0]) << 16 | u32::from(buffer[1]) << 8 | u32::from(buffer[2]);
        for index in 0..4 {
            if index <= chunk.len() {
                output.push(TABLE[(value >> (18 - index * 6)) as usize & 63] as char);
            }
        }
    }
    output
}

fn rendered_at(path: &Option<PathBuf>) -> Option<u64> {
    let modified = fs::metadata(path.as_ref()?).ok()?.modified().ok()?;
    Some(
        modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()?
            .as_secs(),
    )
}

fn render_root(path: &Path) -> Result<PathBuf> {
    let name = path
        .file_name()
        .ok_or_else(|| Error::Invalid("授权记录路径无效".into()))?
        .to_string_lossy();
    Ok(path.with_file_name(format!("{name}.d")))
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIACiTCENvMi768W+epq2eiN++GZs+YTo/kGT/R0YQeNM user@host";

    fn store(directory: &Path) -> AccessKeys {
        AccessKeys::open(&directory.join("gateway-access.json")).unwrap()
    }

    #[test]
    fn renders_one_file_per_profile_and_keeps_it_after_edits() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path());
        assert!(store.rendered("browser").is_none());
        let entry = store.add("browser", KEY).unwrap();
        let path = store.rendered("browser").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap().trim(), KEY);
        assert_eq!(
            store.list().unwrap()[0].keys[0].fingerprint,
            entry.fingerprint
        );
    }

    #[test]
    fn duplicate_key_is_idempotent_and_removal_keeps_file_present() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path());
        let first = store.add("pi", KEY).unwrap();
        let second = store.add("pi", KEY).unwrap();
        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(store.list().unwrap()[0].keys.len(), 1);
        store.remove("pi", &first.fingerprint).unwrap_err();
        assert!(store.rendered("pi").unwrap().is_file());
    }

    #[test]
    fn rejects_options_prefix_unknown_type_and_multiline() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path());
        for raw in [
            r#"command="x" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA"#,
            "ssh-dss AAAAB3NzaC1kc3MAAACB",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA\nssh-ed25519 AAAA",
            "",
        ] {
            store.add("pi", raw).unwrap_err();
        }
    }

    #[test]
    fn fingerprint_matches_openssh_format() {
        let (_, fingerprint) = normalize_key(KEY).unwrap();
        // 与 `ssh-keygen -lf` 的输出一致，此处验证算法前缀与无填充 base64。
        assert!(fingerprint.starts_with("SHA256:"));
        assert!(!fingerprint.ends_with('='));
    }

    #[test]
    fn removing_last_key_is_conflict() {
        let directory = tempfile::tempdir().unwrap();
        let store = store(directory.path());
        let entry = store.add("pi", KEY).unwrap();
        match store.remove("pi", &entry.fingerprint) {
            Err(Error::Conflict(message)) => assert!(message.contains("最后一个")),
            other => panic!("expected conflict, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod fingerprint_tests {
    use super::*;

    #[test]
    fn known_key_matches_openssh_sha256() {
        // 该公钥的 `ssh-keygen -lf` 输出为 SHA256:W43WnGjW/SWQDms/QE3Bkium9Ux5vyVMV7bK4BkGx30。
        let raw = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIACiTCENvMi768W+epq2eiN++GZs+YTo/kGT/R0YQeNM probe@host";
        let (_, fingerprint) = normalize_key(raw).unwrap();
        assert_eq!(
            fingerprint,
            "SHA256:W43WnGjW/SWQDms/QE3Bkium9Ux5vyVMV7bK4BkGx30"
        );
    }
}
