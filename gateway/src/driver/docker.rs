//! docker 驱动（骨架占位）。
//!
//! 经 `driver-docker` feature 启用（依赖重，隔离编译）。职责：容器生命周期
//! 与端口暴露。实现对接 bollard 或 docker CLI，后续 parity 移植时填充。

use async_trait::async_trait;

use super::{Driver, DriverError, Handle, Spec};
use crate::models::Status;

/// Docker 驱动。
pub struct DockerDriver;

impl DockerDriver {
    pub fn new() -> Self {
        Self
    }
}

impl Default for DockerDriver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Driver for DockerDriver {
    fn name(&self) -> &'static str {
        "docker"
    }

    async fn create(&self, _spec: &Spec) -> Result<Handle, DriverError> {
        Err(DriverError::Other("docker 驱动尚未实现".to_string()))
    }

    async fn start(&self, _id: &str) -> Result<(), DriverError> {
        Err(DriverError::Other("docker 驱动尚未实现".to_string()))
    }

    async fn stop(&self, _id: &str) -> Result<(), DriverError> {
        Err(DriverError::Other("docker 驱动尚未实现".to_string()))
    }

    async fn destroy(&self, _id: &str) -> Result<(), DriverError> {
        Err(DriverError::Other("docker 驱动尚未实现".to_string()))
    }

    async fn get(&self, _id: &str) -> Result<Handle, DriverError> {
        Err(DriverError::Other("docker 驱动尚未实现".to_string()))
    }

    async fn list(&self) -> Result<Vec<Handle>, DriverError> {
        Err(DriverError::Other("docker 驱动尚未实现".to_string()))
    }

    async fn status(&self, _id: &str) -> Result<Status, DriverError> {
        Err(DriverError::Other("docker 驱动尚未实现".to_string()))
    }
}
