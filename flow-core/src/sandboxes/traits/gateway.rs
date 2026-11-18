//! Gateway 控制面客户端窄接口。
//!
//! prepare 绑定同一操作身份与冻结规格；get 观察指定资源；release 发出释放意图。
//! 平台端口不持有传输协议或凭据。

use async_trait::async_trait;
use std::sync::Arc;

use crate::sandboxes::error::GatewayError;
use crate::sandboxes::model::{GatewaySandboxView, PrepareReceipt, ReleaseReceipt, SandboxSpec};

/// Gateway 控制面客户端。真实实现由 app 装配（HTTP），测试注入替身。
#[async_trait]
pub trait GatewayClient: Send + Sync {
    /// 请求准备沙箱。`operation_id` 为本域生成的幂等操作身份，
    /// 结果未知时保留身份重试，绑定关系由 Gateway 幂等键保证。
    async fn prepare(
        &self,
        operation_id: &str,
        spec: &SandboxSpec,
    ) -> Result<PrepareReceipt, GatewayError>;

    /// 实时观察沙箱，不存在返回 [`GatewayError::NotFound`]。
    async fn get(&self, sandbox_id: &str) -> Result<GatewaySandboxView, GatewayError>;

    /// 请求释放。受理但未完成时 `confirmed = false`；确认不存在与结果未知须区分。
    async fn release(&self, sandbox_id: &str) -> Result<ReleaseReceipt, GatewayError>;
}

/// `Arc<T>` 共享句柄直接实现 trait：app 装配与测试共享可断言替身时使用。
#[async_trait]
impl<T: GatewayClient + ?Sized> GatewayClient for Arc<T> {
    async fn prepare(
        &self,
        operation_id: &str,
        spec: &SandboxSpec,
    ) -> Result<PrepareReceipt, GatewayError> {
        (**self).prepare(operation_id, spec).await
    }
    async fn get(&self, sandbox_id: &str) -> Result<GatewaySandboxView, GatewayError> {
        (**self).get(sandbox_id).await
    }
    async fn release(&self, sandbox_id: &str) -> Result<ReleaseReceipt, GatewayError> {
        (**self).release(sandbox_id).await
    }
}
