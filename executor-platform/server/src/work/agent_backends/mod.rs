//! 管理员注册的 Agent 执行器。公开描述、私有部署绑定和探测结果分别保存。
mod config;
mod http;
#[cfg(test)]
mod tests;

use super::Error;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub(in crate::work) struct Entry {
    pub(in crate::work) id: String,
    pub(in crate::work) bin: PathBuf,
    pub(in crate::work) policy: PathBuf,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Capability {
    Skills,
    Tools,
    #[serde(rename = "flowOutcome")]
    FlowOutcome,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Description {
    id: String,
    label: String,
    capabilities: Vec<Capability>,
}

struct Backend {
    info: Description,
    entry: Option<Entry>,
    probe_lock: tokio::sync::Mutex<()>,
}

impl Backend {
    fn new(info: Description, binding: Option<(PathBuf, PathBuf)>) -> Self {
        let entry = binding.map(|(bin, policy)| Entry {
            id: info.id.clone(),
            bin,
            policy,
        });
        Self {
            info,
            entry,
            probe_lock: Default::default(),
        }
    }

    fn compatible(&self, snapshot: &Value) -> bool {
        [("skills", Capability::Skills), ("tools", Capability::Tools)]
            .into_iter()
            .all(|(key, capability)| match snapshot.get(key) {
                None => true,
                Some(Value::Array(items)) => {
                    items.is_empty() || self.info.capabilities.contains(&capability)
                }
                Some(_) => false,
            })
    }

    fn view(&self, check: Option<&Check>, snapshot: Option<&Value>) -> Value {
        let mut view = json!({
            "id": self.info.id, "label": self.info.label, "capabilities": self.info.capabilities,
            "configured": self.entry.is_some(), "checkedAt": check.map(|c| c.at),
            "status": match check { None => "unchecked", Some(c) if c.ready => "ready", _ => "failed" },
        });
        if let Some(snapshot) = snapshot {
            view["compatible"] = self.compatible(snapshot).into();
        }
        view
    }
}

struct Check {
    ready: bool,
    at: u64,
}
impl Check {
    fn finished(ready: bool) -> Self {
        Self {
            ready,
            at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        }
    }
}

type Health = BTreeMap<String, Check>;
struct Inner {
    backends: Vec<Backend>,
    health: Mutex<Health>,
}

#[derive(Clone)]
pub(in crate::work) struct Registry(Arc<Inner>);

impl Registry {
    #[cfg(test)]
    pub(in crate::work) fn for_test(entries: Vec<(Entry, bool)>) -> Self {
        let mut health = Health::new();
        let backends = entries
            .into_iter()
            .map(|(entry, ready)| {
                let id = entry.id;
                health.insert(id.clone(), Check::finished(ready));
                Backend::new(
                    Description {
                        label: id.clone(),
                        id,
                        capabilities: vec![Capability::Skills, Capability::Tools],
                    },
                    Some((entry.bin, entry.policy)),
                )
            })
            .collect();
        Self(Arc::new(Inner {
            backends,
            health: Mutex::new(health),
        }))
    }

    fn health(&self) -> Result<MutexGuard<'_, Health>, Error> {
        self.0
            .health
            .lock()
            .map_err(|_| Error::Unavailable("后端检查状态不可用".into()))
    }

    fn backend(&self, id: &str) -> Option<&Backend> {
        self.0.backends.iter().find(|b| b.info.id == id)
    }

    pub(in crate::work) fn supports_flow(&self, id: &str) -> bool {
        self.backend(id).is_some_and(|b| {
            b.entry.is_some() && b.info.capabilities.contains(&Capability::FlowOutcome)
        })
    }

    pub(in crate::work) fn lookup(&self, id: &str) -> Result<Entry, Error> {
        self.backend(id)
            .and_then(|b| b.entry.clone())
            .ok_or_else(|| Error::Unavailable("绑定的 Agent 后端未配置".into()))
    }

    pub(in crate::work) fn select(
        &self,
        requested: Option<&str>,
        snapshot: &Value,
    ) -> Result<Entry, Error> {
        let health = self.health()?;
        let ready = |b: &Backend| health.get(&b.info.id).is_some_and(|c| c.ready);
        if let Some(id) = requested {
            let backend = self
                .backend(id)
                .ok_or_else(|| Error::NotFound("Agent 后端不存在".into()))?;
            if !backend.compatible(snapshot) {
                return Err(Error::Invalid("所选 Agent 后端不支持此配置包的能力".into()));
            }
            if !ready(backend) {
                return Err(Error::Unavailable(
                    "所选 Agent 后端尚未通过可用性检查".into(),
                ));
            }
            return self.lookup(id);
        }
        let mut candidates = self
            .0
            .backends
            .iter()
            .filter(|b| ready(b) && b.compatible(snapshot))
            .filter_map(|b| b.entry.as_ref());
        let entry = candidates
            .next()
            .ok_or_else(|| Error::Unavailable("没有已通过检查且兼容的 Agent 后端".into()))?;
        if candidates.next().is_some() {
            return Err(Error::Conflict(
                "有多个已通过检查且兼容的 Agent 后端，请指定后端 ID".into(),
            ));
        }
        Ok(entry.clone())
    }
}
