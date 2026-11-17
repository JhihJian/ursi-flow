use serde::Deserialize;
use std::{
    fs::{self, File, OpenOptions},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::Duration,
};

pub const MAX_SESSIONS: usize = 64;
pub const MAX_MESSAGE: usize = 1024 * 1024;
pub const EVENT_QUEUE: usize = 32;

pub struct Config {
    pub token: String,
    pub workspace: PathBuf,
    pub state_dir: PathBuf,
    pub runtime_dir: PathBuf,
    pub pi_bin: PathBuf,
    pub provider: String,
    pub model: String,
    pub models: Vec<u8>,
    pub auth: Option<Vec<u8>>,
    pub deadline: Duration,
    pub lock: File,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Model {
    provider: String,
    model: String,
}

fn path(name: &str, default: &str) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| default.into())
}

impl Config {
    pub fn load() -> Result<Self, &'static str> {
        let config_dir = path("URSI_SESSION_CONFIG_DIR", "/run/ursi/config");
        // 生产服务为 root，源配置必须阻止 agent 直接读取 session token。
        if unsafe { libc::geteuid() } == 0 {
            let metadata =
                fs::metadata(&config_dir).map_err(|_| "configuration directory unavailable")?;
            let token_meta = fs::metadata(config_dir.join("session-token"))
                .map_err(|_| "session token unavailable")?;
            let directory_private = metadata.uid() == 0 && metadata.mode() & 0o077 == 0;
            let token_private = token_meta.uid() == 0 && token_meta.mode() & 0o077 == 0;
            if !directory_private && !token_private {
                return Err("session token must be root-private");
            }
        }
        let token = fs::read_to_string(config_dir.join("session-token"))
            .map_err(|_| "session token unavailable")?
            .trim()
            .to_string();
        if token.len() < 32 || token.chars().any(char::is_whitespace) {
            return Err("invalid session token");
        }
        let model: Model = serde_json::from_slice(
            &fs::read(config_dir.join("session.json"))
                .map_err(|_| "session configuration unavailable")?,
        )
        .map_err(|_| "invalid session configuration")?;
        if model.provider.is_empty()
            || model.model.is_empty()
            || model.provider.len() > 256
            || model.model.len() > 256
        {
            return Err("invalid model selection");
        }
        let models = fs::read(config_dir.join("pi/models.json"))
            .map_err(|_| "model configuration unavailable")?;
        serde_json::from_slice::<serde_json::Value>(&models)
            .map_err(|_| "invalid model configuration")?;
        let auth = match fs::read(config_dir.join("pi/auth.json")) {
            Ok(data) => {
                serde_json::from_slice::<serde_json::Value>(&data)
                    .map_err(|_| "invalid auth configuration")?;
                Some(data)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("auth configuration unavailable"),
        };
        let workspace = fs::canonicalize(path("URSI_WORKSPACE_ROOT", "/ursi/workspace"))
            .map_err(|_| "workspace unavailable")?;
        if unsafe { libc::geteuid() } == 0 {
            // 顶层目录归 root，sticky 位保护 root 的状态子目录，agent 组仍可创建仓库。
            use std::os::unix::ffi::OsStrExt;
            let name = std::ffi::CString::new(workspace.as_os_str().as_bytes())
                .map_err(|_| "invalid workspace")?;
            if unsafe { libc::chown(name.as_ptr(), 0, 1000) } != 0 {
                return Err("workspace ownership unavailable");
            }
            fs::set_permissions(&workspace, fs::Permissions::from_mode(0o1770))
                .map_err(|_| "workspace permissions unavailable")?;
        }
        let state_dir = path("URSI_SESSION_STATE_DIR", "/ursi/workspace/.ursi-state");
        secure_dir(&state_dir, 0o700).map_err(|_| "state directory unavailable")?;
        let state_dir = fs::canonicalize(state_dir).map_err(|_| "state directory unavailable")?;
        if state_dir == workspace
            || (state_dir.starts_with(&workspace)
                && state_dir.parent() != Some(workspace.as_path()))
        {
            return Err("state must be a protected workspace child or outside workspace");
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(state_dir.join("service.lock"))
            .map_err(|_| "state lock unavailable")?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("previous service or task cleanup still active");
        }
        let runtime_dir = path("URSI_SESSION_RUNTIME_DIR", "/run/ursi/sessions");
        secure_dir(&runtime_dir, 0o711).map_err(|_| "runtime directory unavailable")?;
        let runtime_dir =
            fs::canonicalize(runtime_dir).map_err(|_| "runtime directory unavailable")?;
        if runtime_dir.starts_with(&workspace)
            || workspace.starts_with(&runtime_dir)
            || runtime_dir == state_dir
        {
            return Err("runtime directory must be outside workspace");
        }
        // 独占锁确认旧 supervisor 已退出后，清除上次崩溃留下的临时凭据。
        for entry in fs::read_dir(&runtime_dir).map_err(|_| "runtime directory unavailable")? {
            let entry = entry.map_err(|_| "runtime cleanup failed")?;
            if uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok() {
                let metadata =
                    fs::symlink_metadata(entry.path()).map_err(|_| "runtime cleanup failed")?;
                if metadata.file_type().is_symlink() {
                    fs::remove_file(entry.path())
                } else {
                    fs::remove_dir_all(entry.path())
                }
                .map_err(|_| "runtime cleanup failed")?;
            }
        }
        let deadline = std::env::var("URSI_SESSION_TASK_TIMEOUT_SECS")
            .ok()
            .map(|s| s.parse::<u64>())
            .transpose()
            .map_err(|_| "invalid task timeout")?
            .unwrap_or(1800);
        if !(1..=86400).contains(&deadline) {
            return Err("invalid task timeout");
        }
        let pi_bin = path("URSI_PI_BIN", "/usr/local/bin/pi");
        if !pi_bin.is_absolute()
            || !fs::metadata(&pi_bin).is_ok_and(|meta| meta.is_file() && meta.mode() & 0o111 != 0)
        {
            return Err("Pi executable unavailable");
        }
        Ok(Self {
            token,
            workspace,
            state_dir,
            runtime_dir,
            pi_bin,
            provider: model.provider,
            model: model.model,
            models,
            auth,
            deadline: Duration::from_secs(deadline),
            lock,
        })
    }
    pub fn cwd(&self, cwd: &str) -> Result<PathBuf, &'static str> {
        let original = Path::new(cwd);
        if !original.is_absolute() {
            return Err("cwd must be absolute");
        }
        let cwd = fs::canonicalize(original).map_err(|_| "cwd unavailable")?;
        if !cwd.is_dir() || !cwd.starts_with(&self.workspace) || cwd.starts_with(&self.state_dir) {
            return Err("cwd must be inside workspace and outside state directory");
        }
        Ok(cwd)
    }
    pub fn prepare_runtime(&self, id: &str) -> Result<PathBuf, &'static str> {
        let root = self.runtime_dir.join(id);
        fs::create_dir(&root).map_err(|_| "runtime allocation failed")?;
        let result = (|| {
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
            let pi = root.join("pi");
            fs::create_dir(&pi)?;
            fs::set_permissions(&pi, fs::Permissions::from_mode(0o700))?;
            write_private(&pi.join("models.json"), &self.models)?;
            if let Some(auth) = &self.auth {
                write_private(&pi.join("auth.json"), auth)?;
            }
            write_private(
                &pi.join("settings.json"),
                br#"{"retry":{"enabled":false},"compaction":{"enabled":false}}"#,
            )?;
            if unsafe { libc::geteuid() } == 0 {
                use std::os::unix::ffi::OsStrExt;
                let mut paths = Vec::new();
                for entry in fs::read_dir(&pi)? {
                    paths.push(entry?.path());
                }
                // 先文件，后内部目录，最后会话根。移交前 agent 无法替换路径。
                paths.push(pi);
                paths.push(root.clone());
                for path in paths {
                    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
                    if unsafe { libc::chown(c.as_ptr(), 1000, 1000) } != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
            }
            Ok::<_, std::io::Error>(())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&root);
            return Err("runtime preparation failed");
        }
        Ok(root)
    }
}

fn secure_dir(path: &Path, mode: u32) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta)
            if meta.file_type().is_symlink()
                || !meta.is_dir()
                || meta.uid() != unsafe { libc::geteuid() } =>
        {
            return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => fs::create_dir_all(path)?,
        Err(e) => return Err(e),
    }
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}
