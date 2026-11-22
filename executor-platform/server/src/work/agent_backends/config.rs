use super::{Backend, Capability, Description, Inner, Registry};
use rustix::fs::{Access, AtFlags, CWD, accessat};
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    env,
    fs::{File, OpenOptions},
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Managed {
    bin: PathBuf,
    #[serde(flatten)]
    info: Description,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn private_file(path: &Path, setting: &'static str) -> io::Result<File> {
    if !path.is_absolute() {
        return Err(invalid(setting));
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| invalid(setting))?;
    let meta = file.metadata().map_err(|_| invalid(setting))?;
    if !meta.is_file()
        || meta.mode() & 0o7777 != 0o600
        || (meta.uid() != 0 && meta.uid() != unsafe { libc::geteuid() })
    {
        return Err(invalid(setting));
    }
    Ok(file)
}

fn executable(path: &Path) -> io::Result<()> {
    if !path.is_absolute()
        || !path.is_file()
        || accessat(CWD, path, Access::EXEC_OK, AtFlags::EACCESS).is_err()
    {
        return Err(invalid("Agent 后端 bin 必须是可执行普通文件的绝对路径"));
    }
    Ok(())
}

fn read_managed(path: &Path) -> io::Result<Vec<Managed>> {
    const LIMIT: u64 = 2 * 1024 * 1024;
    let file = private_file(path, "URSI_AGENT_BACKENDS 必须指向私有 0600 普通文件")?;
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid("无法读取 URSI_AGENT_BACKENDS"))?;
    if bytes.len() as u64 > LIMIT {
        return Err(invalid("URSI_AGENT_BACKENDS 超过 2 MiB"));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| invalid("URSI_AGENT_BACKENDS 需要合法的后端对象数组"))
}

impl Registry {
    pub(in crate::work) fn from_env() -> io::Result<Self> {
        let path = |key| env::var_os(key).map(PathBuf::from);
        Self::load(
            path("URSI_PI_EXECUTOR_BIN"),
            path("URSI_PI_POLICY"),
            path("URSI_AGENT_BACKENDS"),
        )
    }

    pub(super) fn load(
        pi: Option<PathBuf>,
        policy: Option<PathBuf>,
        managed: Option<PathBuf>,
    ) -> io::Result<Self> {
        if let Some(path) = &policy {
            private_file(path, "URSI_PI_POLICY 必须指向私有 0600 普通文件")?;
        }
        if let Some(bin) = &pi {
            executable(bin)?;
            if policy.is_none() {
                return Err(invalid("Pi 后端缺少 URSI_PI_POLICY"));
            }
        }
        let mut backends = vec![Backend::new(
            Description {
                id: "pi".into(),
                label: "Pi".into(),
                capabilities: vec![
                    Capability::Skills,
                    Capability::Tools,
                    Capability::FlowOutcome,
                ],
            },
            pi.zip(policy.clone()),
        )];
        let mut ids = BTreeSet::from(["flow".to_owned(), "pi".to_owned()]);
        if let Some(path) = managed {
            for Managed { bin, info } in read_managed(&path)? {
                let id = info.id.as_bytes();
                if id.len() > 64
                    || !id.first().is_some_and(u8::is_ascii_alphanumeric)
                    || !id.iter().all(|b| {
                        b.is_ascii_lowercase()
                            || b.is_ascii_digit()
                            || matches!(b, b'-' | b'_' | b'.')
                    })
                    || !ids.insert(info.id.clone())
                {
                    return Err(invalid("Agent 后端 ID 无效、重复或保留"));
                }
                if info.label.is_empty()
                    || info.label.len() > 128
                    || info.label.trim() != info.label
                    || info.label.chars().any(char::is_control)
                {
                    return Err(invalid("Agent 后端 label 需要非空显示名称"));
                }
                if info
                    .capabilities
                    .iter()
                    .enumerate()
                    .any(|(i, c)| info.capabilities[..i].contains(c))
                {
                    return Err(invalid("Agent 后端能力不能重复"));
                }
                executable(&bin)?;
                let policy = policy
                    .clone()
                    .ok_or_else(|| invalid("受管 Agent 后端缺少 URSI_PI_POLICY"))?;
                backends.push(Backend::new(info, Some((bin, policy))));
            }
        }
        Ok(Self(Arc::new(Inner {
            backends,
            health: Default::default(),
        })))
    }
}
