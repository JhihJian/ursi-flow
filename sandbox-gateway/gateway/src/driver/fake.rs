//! fake 驱动：内存实现，用于测试与无 Docker 环境开发。
//!
//! 对齐 grasp gateway internal/driver/fake 的语义：记录调用输入供断言，
//! 状态迁移确定性。

use async_trait::async_trait;
use std::sync::Mutex;

use super::{Driver, DriverError, Handle, Spec};
use crate::models::Status;

#[derive(Default)]
struct Inner {
    sandboxes: Vec<Handle>,
    last_spec: Option<Spec>,
}

/// 内存 fake 驱动。
pub struct FakeDriver {
    inner: Mutex<Inner>,
}

impl FakeDriver {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
        }
    }

    /// 最近一次 create 收到的规格，供测试断言。
    pub fn last_spec(&self) -> Option<Spec> {
        self.inner.lock().unwrap().last_spec.clone()
    }
}

#[async_trait]
impl Driver for FakeDriver {
    fn name(&self) -> &'static str {
        "fake"
    }

    async fn create(&self, spec: &Spec) -> Result<Handle, DriverError> {
        let mut inner = self.inner.lock().unwrap();
        inner.last_spec = Some(spec.clone());
        let id = format!("fake-{}", inner.sandboxes.len() + 1);
        let handle = Handle {
            id: id.clone(),
            name: id,
            status: Status::Running,
            endpoints: spec.ports.iter().map(|p| (*p, format!("127.0.0.1:{}", p))).collect(),
        };
        inner.sandboxes.push(handle.clone());
        Ok(handle)
    }

    async fn start(&self, id: &str) -> Result<(), DriverError> {
        let mut inner = self.inner.lock().unwrap();
        let sb = inner
            .sandboxes
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| DriverError::NotFound(id.to_string()))?;
        sb.status = Status::Running;
        Ok(())
    }

    async fn stop(&self, id: &str) -> Result<(), DriverError> {
        let mut inner = self.inner.lock().unwrap();
        let sb = inner
            .sandboxes
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| DriverError::NotFound(id.to_string()))?;
        sb.status = Status::Stopped;
        Ok(())
    }

    async fn destroy(&self, id: &str) -> Result<(), DriverError> {
        let mut inner = self.inner.lock().unwrap();
        let before = inner.sandboxes.len();
        inner.sandboxes.retain(|s| s.id != id);
        if inner.sandboxes.len() == before {
            return Err(DriverError::NotFound(id.to_string()));
        }
        Ok(())
    }

    async fn get(&self, id: &str) -> Result<Handle, DriverError> {
        self.inner
            .lock()
            .unwrap()
            .sandboxes
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| DriverError::NotFound(id.to_string()))
    }

    async fn list(&self) -> Result<Vec<Handle>, DriverError> {
        Ok(self.inner.lock().unwrap().sandboxes.clone())
    }

    async fn status(&self, id: &str) -> Result<Status, DriverError> {
        Ok(self.get(id).await?.status)
    }
}
