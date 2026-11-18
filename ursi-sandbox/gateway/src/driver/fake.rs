//! 确定性的内存驱动，按 (id, generation) 保存实际资源。
//!
//! `fail_next("create")` 在下一次首次创建时失败，`ensure` 等 trait 操作名
//! 在操作前失败。`ensure_after_volume`、`ensure_after_create` 模拟部分成功，
//! 重新调用 ensure 可接回资源。失败返回 Unavailable，不会伪装成不存在。

use super::Driver;
use crate::models::{
    Capabilities, Endpoint, Error, Observed, Resource, Result, Sandbox, valid_name,
};
use async_trait::async_trait;
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};

#[derive(Clone)]
struct Entry {
    data_generation: u64,
    observed: Observed,
    logs: Vec<String>,
}

#[derive(Default)]
struct Inner {
    resources: HashMap<(String, u64), Entry>,
    volumes: HashSet<(String, u64)>,
    failures: HashMap<String, usize>,
}

impl Inner {
    fn fail(&mut self, operation: &str) -> Result<()> {
        if let Some(count) = self.failures.get_mut(operation) {
            if *count > 0 {
                *count -= 1;
                return Err(Error::Unavailable(format!("fake {operation}: 注入故障")));
            }
        }
        Ok(())
    }

    fn entry(&mut self, sandbox: &Sandbox) -> Result<&mut Entry> {
        validate(&sandbox.id, sandbox.resource)?;
        let entry = self
            .resources
            .get_mut(&(sandbox.id.clone(), sandbox.resource.generation))
            .ok_or_else(|| Error::NotFound(sandbox.id.clone()))?;
        if entry.data_generation != sandbox.resource.data_generation {
            return Err(Error::Conflict("fake 数据代次不匹配".into()));
        }
        Ok(entry)
    }
}

#[derive(Default)]
pub struct FakeDriver {
    inner: Mutex<Inner>,
}

impl FakeDriver {
    pub fn new() -> Self {
        Self::default()
    }

    /// 每次调用增加一次对应操作的故障，不影响其他操作。
    pub fn fail_next(&self, operation: &str) {
        *self
            .inner
            .lock()
            .unwrap()
            .failures
            .entry(operation.into())
            .or_default() += 1;
    }
}

fn validate(id: &str, resource: Resource) -> Result<()> {
    if !valid_name(id) || resource.generation == 0 || resource.data_generation == 0 {
        return Err(Error::Invalid("资源 id 或代次非法".into()));
    }
    Ok(())
}

fn endpoints(sandbox: &Sandbox) -> Vec<Endpoint> {
    sandbox
        .spec
        .ports
        .iter()
        .map(|port| Endpoint {
            name: port.name.clone(),
            port: port.port,
            visibility: port.visibility,
            address: format!("127.0.0.1:{}", port.port),
        })
        .collect()
}

#[async_trait]
impl Driver for FakeDriver {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            rebuild_preserve_data: true,
            rebuild_destroy_data: true,
        }
    }

    async fn ensure(&self, sandbox: &Sandbox) -> Result<Observed> {
        sandbox.spec.validate()?;
        validate(&sandbox.id, sandbox.resource)?;
        let mut inner = self.inner.lock().unwrap();
        inner.fail("ensure")?;
        let key = (sandbox.id.clone(), sandbox.resource.generation);
        if !inner.resources.contains_key(&key) {
            inner.fail("create")?;
            inner
                .volumes
                .insert((sandbox.id.clone(), sandbox.resource.data_generation));
            inner.fail("ensure_after_volume")?;
            inner.resources.insert(
                key,
                Entry {
                    data_generation: sandbox.resource.data_generation,
                    observed: Observed {
                        running: false,
                        endpoints: endpoints(sandbox),
                        healthy: None,
                    },
                    logs: vec!["created".into()],
                },
            );
            inner.fail("ensure_after_create")?;
        }
        let entry = inner.entry(sandbox)?;
        if !entry.observed.running {
            entry.logs.push("started".into());
        }
        entry.observed.running = true;
        Ok(entry.observed.clone())
    }

    async fn start(&self, sandbox: &Sandbox) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.fail("start")?;
        let entry = inner.entry(sandbox)?;
        if !entry.observed.running {
            entry.logs.push("started".into());
        }
        entry.observed.running = true;
        Ok(())
    }

    async fn stop(&self, sandbox: &Sandbox) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.fail("stop")?;
        let entry = inner.entry(sandbox)?;
        if entry.observed.running {
            entry.logs.push("stopped".into());
        }
        entry.observed.running = false;
        Ok(())
    }

    async fn remove(&self, id: &str, resource: Resource, remove_data: bool) -> Result<()> {
        validate(id, resource)?;
        let mut inner = self.inner.lock().unwrap();
        inner.fail("remove")?;
        let key = (id.to_owned(), resource.generation);
        if inner
            .resources
            .get(&key)
            .is_some_and(|entry| entry.data_generation != resource.data_generation)
        {
            return Err(Error::Conflict("fake 数据代次不匹配".into()));
        }
        if remove_data
            && inner.resources.iter().any(|(other_key, entry)| {
                other_key != &key
                    && other_key.0 == id
                    && entry.data_generation == resource.data_generation
            })
        {
            return Err(Error::Conflict("fake 数据卷仍被其他代次使用".into()));
        }
        inner.resources.remove(&key);
        if remove_data {
            inner.volumes.remove(&(id.into(), resource.data_generation));
        }
        Ok(())
    }

    async fn observe(&self, sandbox: &Sandbox) -> Result<Observed> {
        let mut inner = self.inner.lock().unwrap();
        inner.fail("observe")?;
        let mut observed = inner.entry(sandbox)?.observed.clone();
        if !observed.running {
            observed.endpoints.clear();
        }
        Ok(observed)
    }

    async fn logs(&self, sandbox: &Sandbox, tail: usize) -> Result<String> {
        let mut inner = self.inner.lock().unwrap();
        inner.fail("logs")?;
        let entry = inner.entry(sandbox)?;
        Ok(entry.logs[entry.logs.len().saturating_sub(tail.min(5000))..].join("\n"))
    }
}

#[cfg(test)]
#[path = "fake_tests.rs"]
mod tests;
