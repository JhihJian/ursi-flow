use super::{Error, plan::Requirements};
use std::{
    cmp::Reverse,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::watch;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError};

pub(super) const LOCAL_AGENT_ID: &str = "local-agent";
pub(super) const LOCAL_AGENT_REVISION: u64 = 1;
const DEFAULT_PRIORITY: i32 = 100;
const DEFAULT_CAPACITY: usize = 4;

#[derive(Clone, Copy, Debug)]
pub(super) struct Capabilities {
    pub(super) text_instruction: bool,
    pub(super) config_package: bool,
}

#[derive(Clone, Debug)]
pub(super) struct Registration {
    pub(super) id: String,
    pub(super) revision: u64,
    pub(super) priority: i32,
    pub(super) capacity: usize,
    pub(super) ready: bool,
    pub(super) capabilities: Capabilities,
    pub(super) bin: Option<PathBuf>,
}

struct Entry {
    registration: Registration,
    permits: Arc<Semaphore>,
}

pub(super) struct Lease {
    pub(super) id: String,
    pub(super) revision: u64,
    bin: PathBuf,
    _permit: OwnedSemaphorePermit,
}

impl Lease {
    pub(super) async fn run(
        &self,
        workspace: &Path,
        artifact: &Path,
        instruction: String,
        config: Option<&Path>,
        cancel: &mut watch::Receiver<bool>,
    ) -> super::Outcome {
        super::agent::run(
            &self.bin,
            workspace,
            artifact,
            instruction,
            config,
            cancel,
            super::agent::DEADLINE,
        )
        .await
    }
}

#[derive(Debug)]
pub(super) enum SelectError {
    Unavailable,
    Busy,
}

pub(super) struct Registry {
    entries: Vec<Arc<Entry>>,
}

impl Registry {
    pub(super) fn local(bin: Option<PathBuf>) -> Self {
        Self::from_registrations(vec![Registration {
            id: LOCAL_AGENT_ID.to_owned(),
            revision: LOCAL_AGENT_REVISION,
            priority: DEFAULT_PRIORITY,
            capacity: DEFAULT_CAPACITY,
            ready: true,
            capabilities: Capabilities {
                text_instruction: true,
                config_package: true,
            },
            bin,
        }])
        .expect("内置本地 Agent 集成配置固定有效")
    }

    fn from_registrations(registrations: Vec<Registration>) -> Result<Self, Error> {
        let mut entries = Vec::with_capacity(registrations.len());
        for registration in registrations {
            if registration.id.is_empty()
                || registration.id.len() > 128
                || !registration
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
                || registration.capacity > Semaphore::MAX_PERMITS
                || registration.revision == 0
                || registration.capacity == 0
            {
                return Err(Error::Invalid("执行器集成注册信息无效".into()));
            }
            if entries.iter().any(|entry: &Arc<Entry>| {
                entry.registration.id == registration.id
                    && entry.registration.revision == registration.revision
            }) {
                return Err(Error::Conflict("执行器集成注册信息重复".into()));
            }
            entries.push(Arc::new(Entry {
                permits: Arc::new(Semaphore::new(registration.capacity)),
                registration,
            }));
        }

        Ok(Self { entries })
    }

    pub(super) fn contains(&self, id: &str, revision: u64) -> bool {
        self.entries
            .iter()
            .any(|e| e.registration.id == id && e.registration.revision == revision)
    }

    pub(super) fn select(&self, requirements: Requirements) -> Result<Lease, SelectError> {
        let mut capacity_blocked = false;
        let mut candidates: Vec<_> = self.entries.iter().collect();
        // 稳定排序，负载相同时保留注册顺序。真正的容量预留由 semaphore 原子完成。
        candidates.sort_by_cached_key(|e| {
            (
                Reverse(e.registration.priority),
                e.registration.capacity - e.permits.available_permits(),
            )
        });
        for entry in candidates {
            let registration = &entry.registration;
            if !registration.ready
                || !registration.capabilities.text_instruction
                || (requirements.config_package && !registration.capabilities.config_package)
            {
                continue;
            }
            let Some(bin) = registration.bin.as_ref().filter(|p| {
                p.is_absolute()
                    && p.metadata()
                        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            }) else {
                continue;
            };
            let permit = match Arc::clone(&entry.permits).try_acquire_owned() {
                Ok(permit) => permit,
                Err(TryAcquireError::NoPermits) => {
                    capacity_blocked = true;
                    continue;
                }
                Err(TryAcquireError::Closed) => continue,
            };
            return Ok(Lease {
                id: registration.id.clone(),
                revision: registration.revision,
                bin: bin.clone(),
                _permit: permit,
            });
        }
        if capacity_blocked {
            Err(SelectError::Busy)
        } else {
            Err(SelectError::Unavailable)
        }
    }

    #[cfg(test)]
    fn test(registrations: Vec<Registration>) -> Self {
        Self::from_registrations(registrations).unwrap()
    }
}

pub(super) fn selection_error(error: SelectError) -> Error {
    match error {
        SelectError::Unavailable => Error::Unavailable("没有匹配且就绪的执行器集成".into()),
        SelectError::Busy => Error::Unavailable("执行器集成当前容量已满".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration(id: &str, priority: i32, capacity: usize, ready: bool) -> Registration {
        Registration {
            id: id.into(),
            revision: 1,
            priority,
            capacity,
            ready,
            capabilities: Capabilities {
                text_instruction: true,
                config_package: true,
            },
            bin: Some(PathBuf::from("/bin/sh")),
        }
    }

    #[test]
    fn selects_ready_high_priority_and_stable_order() {
        let registry = Registry::test(vec![
            registration("low", 10, 1, true),
            registration("high-b", 20, 2, true),
            registration("high-a", 20, 2, true),
        ]);
        let first = registry
            .select(Requirements {
                config_package: false,
            })
            .unwrap();
        assert_eq!(first.id, "high-b");
        let second = registry
            .select(Requirements {
                config_package: false,
            })
            .unwrap();
        assert_eq!(second.id, "high-a");
    }

    #[test]
    fn skips_unhealthy_and_full_entries() {
        let registry = Registry::test(vec![
            registration("unhealthy", 30, 1, false),
            registration("full", 20, 1, true),
            registration("fallback", 10, 1, true),
        ]);
        let held = registry
            .select(Requirements {
                config_package: false,
            })
            .unwrap();
        assert_eq!(held.id, "full");
        let fallback = registry
            .select(Requirements {
                config_package: false,
            })
            .unwrap();
        assert_eq!(fallback.id, "fallback");
        assert!(matches!(
            registry.select(Requirements {
                config_package: false
            }),
            Err(SelectError::Busy)
        ));
    }

    #[test]
    fn rejects_duplicate_and_zero_capacity_registration() {
        let duplicate = Registry::from_registrations(vec![
            registration("same", 1, 1, true),
            registration("same", 1, 1, true),
        ]);
        assert!(duplicate.is_err());
        let zero = Registry::from_registrations(vec![registration("zero", 1, 0, true)]);
        assert!(zero.is_err());
    }
}
