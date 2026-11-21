//! Resolve an Agent target once and bind its private snapshot to one attempt.
use super::{Error, ExecutorRef, Start};
use crate::work::{Store, catalog};
use rustix::fs::{self as at, Mode, OFlags, ResolveFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use catalog::SNAPSHOT_LIMIT;

#[derive(Clone)]
pub(super) enum Backend {
    Flow {
        bin: PathBuf,
        env: [Option<String>; 3],
    },
    Pi {
        bin: PathBuf,
        policy: PathBuf,
    },
}

impl Backend {
    pub(super) fn bin(&self) -> &Path {
        match self {
            Self::Flow { bin, .. } | Self::Pi { bin, .. } => bin,
        }
    }

    pub(super) fn binding(&self) -> Value {
        match self {
            // Keep the identity of Flow attempts reserved before Pi was supported.
            Self::Flow {
                bin,
                env: [flow, revision, home],
            } => json!([bin, flow, revision, home]),
            Self::Pi { bin, policy } => json!(["pi", bin, policy]),
        }
    }

    pub(super) fn mode(&self) -> &'static str {
        match self {
            Self::Flow { .. } => "flow",
            Self::Pi { .. } => "pi",
        }
    }
}

pub(super) const FLOW_ENV: [&str; 3] = [
    "URSI_EXECUTOR_FLOW",
    "URSI_EXECUTOR_FLOW_REVISION",
    "URSI_FLOW_HOME",
];

pub(super) fn flow_from_env() -> Option<Backend> {
    let bin = absolute_env("URSI_EXECUTOR_BIN")?;
    Some(Backend::Flow {
        env: FLOW_ENV.map(|key| std::env::var(key).ok()),
        bin,
    })
}

pub(super) fn pi_from_env() -> Option<Backend> {
    let bin = absolute_env("URSI_PI_EXECUTOR_BIN")?;
    let policy = absolute_env("URSI_PI_POLICY")?;
    policy_file(&policy).ok()?;
    Some(Backend::Pi { bin, policy })
}

fn absolute_env(name: &str) -> Option<PathBuf> {
    let path = std::env::var(name).ok().map(PathBuf::from)?;
    path.is_absolute().then_some(path)
}

fn policy_file(path: &Path) -> Result<(), Error> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| unavailable())?;
    let metadata = file.metadata().map_err(|_| unavailable())?;
    if !metadata.is_file()
        || metadata.mode() & 0o7777 != 0o600
        || (metadata.uid() != 0 && metadata.uid() != unsafe { libc::geteuid() })
    {
        return Err(unavailable());
    }
    Ok(())
}

pub(super) fn target(start: &Start) -> Result<Target, Error> {
    match (&start.executor_ref, &start.preview_definition) {
        (Some(_), Some(_)) => Err(Error::Invalid("不能同时指定执行器版本和 Agent 预览".into())),
        (Some(reference), None) => Ok(Target::Published(reference.clone())),
        (None, Some(definition)) => Ok(Target::Preview(definition.clone())),
        (None, None) => Ok(Target::Flow),
    }
}

#[derive(Clone)]
pub(super) enum Target {
    Flow,
    Published(ExecutorRef),
    Preview(Value),
}

pub(super) fn resolve(
    store: &Store,
    target: &Target,
    flow: Option<&Backend>,
    pi: Option<&Backend>,
) -> Result<(Backend, Option<Value>), Error> {
    match target {
        Target::Flow => Ok((flow.cloned().ok_or_else(unavailable)?, None)),
        Target::Published(reference) => {
            let backend = pi.cloned().ok_or_else(unavailable)?;
            let config =
                store.read(|db| catalog::agent_snapshot(db, &reference.id, reference.revision))?;
            Ok((backend, Some(config)))
        }
        Target::Preview(definition) => {
            let backend = pi.cloned().ok_or_else(unavailable)?;
            let config = catalog::agent_preview(store, definition)?;
            Ok((backend, Some(config)))
        }
    }
}

pub(super) fn backend_for_row(
    row: &Value,
    flow: Option<&Backend>,
    pi: Option<&Backend>,
) -> Result<Backend, Error> {
    let mode = row["backend"].as_str().unwrap_or("flow");
    let backend = match mode {
        "flow" => flow,
        "pi" => pi,
        _ => None,
    };
    let backend = backend.ok_or_else(unavailable)?;
    if row["binding"] != backend.binding() {
        return Err(unavailable());
    }
    Ok(backend.clone())
}

pub(super) fn unavailable() -> Error {
    Error::Unavailable("执行器未启用、绑定已变更或响应无法核实".into())
}

fn attempt_dir(root: &Path, id: &str) -> Result<std::os::fd::OwnedFd, Error> {
    at::openat2(
        at::CWD,
        root.join(id),
        OFlags::DIRECTORY | OFlags::RDONLY | OFlags::CLOEXEC,
        Mode::empty(),
        ResolveFlags::NO_SYMLINKS,
    )
    .map_err(|_| unavailable())
}

pub(super) fn create_snapshot(root: &Path, id: &str, config: &Value) -> Result<String, Error> {
    let dir = attempt_dir(root, id)?;
    let bytes =
        serde_json::to_vec(config).map_err(|_| Error::Internal("Agent 快照编码失败".into()))?;
    if bytes.len() > SNAPSHOT_LIMIT {
        return Err(Error::Invalid("Agent 快照超过 2 MiB".into()));
    }
    let mut file = fs::File::from(
        at::openat(
            &dir,
            "agent-config.json",
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR,
        )
        .map_err(|_| unavailable())?,
    );
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| unavailable())?;
    at::fsync(&dir).map_err(|_| unavailable())?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

pub(super) fn verify_snapshot(root: &Path, id: &str, expected: &str) -> Result<(), Error> {
    let file = fs::File::from(
        at::openat(
            attempt_dir(root, id)?,
            "agent-config.json",
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| unavailable())?,
    );
    let metadata = file.metadata().map_err(|_| unavailable())?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o400
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.len() > SNAPSHOT_LIMIT as u64
    {
        return Err(unavailable());
    }
    let mut bytes = Vec::new();
    file.take(SNAPSHOT_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() > SNAPSHOT_LIMIT || format!("{:x}", Sha256::digest(&bytes)) != expected {
        return Err(unavailable());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};
    use uuid::Uuid;

    #[test]
    fn target_rejects_mixed_agent_shapes_and_preserves_legacy_flow() {
        let flow = Start {
            executor_ref: None,
            preview_definition: None,
            work_instruction: super::super::Instruction {
                text: "x".into(),
                encoding: "utf-8".into(),
            },
            work_patch_id: None,
            run_config: Default::default(),
        };
        assert!(matches!(target(&flow), Ok(Target::Flow)));
        let encoded = serde_json::to_value(&flow).unwrap();
        assert!(encoded.get("executorRef").is_none());
        assert!(encoded.get("previewDefinition").is_none());
        for field in ["executorRef", "previewDefinition"] {
            let mut invalid = encoded.clone();
            invalid[field] = Value::Null;
            assert!(serde_json::from_value::<Start>(invalid).is_err());
        }
        let mut both = flow.clone();
        both.executor_ref = Some(ExecutorRef {
            id: "agent".into(),
            revision: 1,
        });
        both.preview_definition = Some(json!({"id":"agent"}));
        assert!(matches!(target(&both), Err(Error::Invalid(_))));
    }

    #[test]
    fn old_published_revision_uses_its_snapshot_without_package_lookup() {
        let path = std::env::temp_dir().join(Uuid::new_v4().to_string());
        let store = Store::open(path.clone()).unwrap();
        let inline = json!({"id":"old","agent":{"systemPrompt":"original","modelProfile":"managed","tools":[]},"resources":[{"id":"legacy","revision":7}]});
        let snapshot = json!({"systemPrompt":"original","modelProfile":"managed","tools":[],"skills":[{"id":"legacy","revision":7,"content":"fixed"}]});
        store
            .update(|db| {
                let mut revision = inline.clone();
                revision["revision"] = 1.into();
                db["catalog"]["executors"]["old"] =
                    json!({"active":true,"revisions":[revision],"agentSnapshots":{"1":snapshot}});
                Ok(())
            })
            .unwrap();
        let pi = Backend::Pi {
            bin: "/pi".into(),
            policy: "/private".into(),
        };
        let target = Target::Published(ExecutorRef {
            id: "old".into(),
            revision: 1,
        });
        assert_eq!(
            resolve(&store, &target, None, Some(&pi)).unwrap().1,
            Some(snapshot)
        );
        assert!(matches!(
            resolve(&store, &Target::Preview(inline), None, Some(&pi)),
            Err(Error::Invalid(_))
        ));
        drop(store);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn restores_original_driver_without_fallback() {
        let flow = Backend::Flow {
            bin: "/flow".into(),
            env: [Some("f".into()), None, None],
        };
        let pi = Backend::Pi {
            bin: "/pi".into(),
            policy: "/private".into(),
        };
        let legacy = json!({"binding":["/flow", "f", null, null]});
        let agent = json!({"backend":"pi", "binding":["pi", "/pi", "/private"]});
        for (row, path) in [(&legacy, flow.bin()), (&agent, pi.bin())] {
            assert_eq!(
                backend_for_row(row, Some(&flow), Some(&pi)).unwrap().bin(),
                path
            );
        }
        assert!(backend_for_row(&agent, Some(&flow), None).is_err());
        let changed = Backend::Pi {
            bin: "/pi".into(),
            policy: "/other".into(),
        };
        assert!(backend_for_row(&agent, Some(&flow), Some(&changed)).is_err());
    }

    #[test]
    fn snapshot_is_private_read_only_and_stable() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir_all(root.join("id")).unwrap();
        let config =
            json!({"systemPrompt":"fixed","modelProfile":"managed","skills":[],"tools":[]});
        let digest = create_snapshot(&root, "id", &config).unwrap();
        let path = root.join("id/agent-config.json");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o400
        );
        verify_snapshot(&root, "id", &digest).unwrap();
        assert!(create_snapshot(&root, "id", &config).is_err());
        fs::remove_file(&path).unwrap();
        create_snapshot(&root, "id", &json!({"changed":true})).unwrap();
        assert!(verify_snapshot(&root, "id", &digest).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
