//! Gateway 控制面客户端窄接口。
//!
//! 语义对齐 Gateway 契约：`prepare` 对应 `POST /api/v1/sandboxes`
//! （202 受理，幂等键绑定规格与沙箱），`get` 对应
//! `GET /api/v1/sandboxes/{id}`（平台视图），`release` 对应
//! `DELETE /api/v1/sandboxes/{id}`（202 删除意图，完成后查询 404）。
//!
//! 结果未知（响应丢失、超时）由实现方返回 [`GatewayError::Unknown`]；
//! 受理被拒（4xx/5xx）返回 [`GatewayError::Failed`]；同一操作身份
//! 绑定其他规格返回 [`GatewayError::Conflict`]。

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

    /// 查询沙箱平台视图。不存在返回
    /// [`GatewayError::Failed`]（对应契约 404，由实现方映射）。
    async fn get(&self, sandbox_id: &str) -> Result<GatewaySandboxView, GatewayError>;

    /// 请求释放沙箱。未确认受理时回执 `confirmed = false`；
    /// 结果未知时返回 [`GatewayError::Unknown`]，意图受理状态不变。
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
