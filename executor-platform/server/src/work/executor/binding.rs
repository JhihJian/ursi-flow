//! Resolve an Agent target once and bind its private snapshot to one attempt.
use super::{Error, ExecutorRef, Start};
use crate::work::{
    Store,
    agent_backends::{Entry, Registry},
    catalog,
};
use rustix::fs::{self as at, Mode, OFlags, ResolveFlags};
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::MetadataExt,
    path::Path,
};

use catalog::SNAPSHOT_LIMIT;

pub(super) fn target(start: &Start) -> Result<Target, Error> {
    match (&start.executor_ref, &start.preview_definition) {
        (Some(_), Some(_)) => Err(Error::Invalid("不能同时指定执行器版本和 Agent 预览".into())),
        (Some(reference), None) => Ok(Target::Published(reference.clone())),
        (None, Some(definition)) => Ok(Target::Preview(definition.clone())),
        (None, None) => Err(Error::Invalid("需要指定执行器版本或 Agent 预览".into())),
    }
}

#[derive(Clone)]
pub(super) enum Target {
    Published(ExecutorRef),
    Preview(Value),
}

pub(super) fn resolve(
    store: &Store,
    target: &Target,
    registry: &Registry,
) -> Result<(Entry, Value), Error> {
    match target {
        Target::Published(reference) => {
            let (entry, config) =
                catalog::published_agent(store, registry, &reference.id, reference.revision)?;
            Ok((entry, config))
        }
        Target::Preview(definition) => {
            let config = catalog::agent_preview(store, definition)?;
            let entry = registry.select(definition["agent"]["backendId"].as_str(), &config)?;
            Ok((entry, config))
        }
    }
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

pub(super) fn read_snapshot(root: &Path, id: &str, expected: &str) -> Result<Value, Error> {
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
    serde_json::from_slice(&bytes).map_err(|_| unavailable())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};
    use uuid::Uuid;

    #[test]
    fn target_requires_exactly_one_selector() {
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
        assert!(matches!(target(&flow), Err(Error::Invalid(_))));
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
        let registry = Registry::for_test(vec![
            (entry("pi", "/pi", "/private"), true),
            (entry("alternate", "/alternate", "/private"), true),
        ]);
        let target = Target::Published(ExecutorRef {
            id: "old".into(),
            revision: 1,
        });
        assert!(matches!(
            resolve(&store, &target, &registry),
            Err(Error::Unavailable(_))
        ));
        for saved in [
            json!(["pi", "/pi", "/private"]),
            catalog::entry_binding(&entry("pi", "/pi", "/private")),
        ] {
            store
                .update(|db| {
                    db["catalog"]["executors"]["old"]["agentBindings"]["1"] = saved.clone();
                    Ok(())
                })
                .unwrap();
            let result = resolve(&store, &target, &registry);
            if saved[0] == "acp-v2" {
                assert_eq!(result.unwrap().1, snapshot);
            } else {
                assert!(matches!(result, Err(Error::Unavailable(_))));
            }
        }
        let moved = Registry::for_test(vec![(entry("pi", "/changed", "/private"), true)]);
        assert!(matches!(
            resolve(&store, &target, &moved),
            Err(Error::Unavailable(_))
        ));
        assert!(matches!(
            resolve(&store, &Target::Preview(inline), &registry),
            Err(Error::Invalid(_))
        ));
        drop(store);
        fs::remove_dir_all(path).unwrap();
    }

    fn entry(id: &str, bin: &str, policy: &str) -> Entry {
        Entry {
            id: id.into(),
            bin: bin.into(),
            policy: policy.into(),
        }
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
        read_snapshot(&root, "id", &digest).unwrap();
        assert!(create_snapshot(&root, "id", &config).is_err());
        fs::remove_file(&path).unwrap();
        create_snapshot(&root, "id", &json!({"changed":true})).unwrap();
        assert!(read_snapshot(&root, "id", &digest).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
