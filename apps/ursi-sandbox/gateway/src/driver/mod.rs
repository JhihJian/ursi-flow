use crate::models::{Capabilities, Observed, Resource, Result, Sandbox};
use async_trait::async_trait;
use std::collections::{BTreeMap, BTreeSet};

#[cfg(feature = "driver-docker")]
pub mod docker;
#[cfg(feature = "driver-fake")]
pub mod fake;
#[cfg(feature = "driver-docker")]
pub mod profiles;

#[async_trait]
pub trait Driver: Send + Sync {
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> Capabilities;
    fn validate_spec(&self, spec: &crate::models::SandboxSpec) -> Result<()> {
        spec.validate()
    }
    /// 幂等创建或接回该代资源并启动。命名卷按 data_generation 稳定命名。
    async fn ensure(&self, sandbox: &Sandbox) -> Result<Observed>;
    async fn start(&self, sandbox: &Sandbox) -> Result<()>;
    async fn stop(&self, sandbox: &Sandbox) -> Result<()>;
    /// 幂等移除指定代资源，可选删除指定代数据卷；不存在视为成功。
    async fn remove(&self, id: &str, resource: Resource, remove_data: bool) -> Result<()>;
    /// 仅明确不存在时返回 NotFound，网络/daemon错误必须区分。
    async fn observe(&self, sandbox: &Sandbox) -> Result<Observed>;
    async fn logs(&self, sandbox: &Sandbox, tail: usize) -> Result<String>;
    async fn local_images(
        &self,
        _references: &BTreeSet<String>,
    ) -> Result<BTreeMap<String, String>> {
        Err(crate::models::Error::Unsupported(
            "local image inventory".into(),
        ))
    }
    async fn capture_target(&self, _sandbox: &Sandbox) -> Result<serde_json::Value> {
        Err(crate::models::Error::Unsupported(
            "network observations".into(),
        ))
    }
    /// 容器是否已用授权渲染文件覆盖挂载。None 表示驱动不提供该证据。
    async fn access_attached(&self, _sandbox: &Sandbox) -> Result<Option<bool>> {
        Ok(None)
    }
}
