//! 连接网关窄接口：roles 对 connections 的全部依赖收敛于此。
//!
//! DESIGN「模块边界」：roles 调用 connections 的配置查询与引用接口，
//! 被调用方不回调上游域。本 trait 只暴露 roles 需要的最小能力面：
//! 查询可冻结连接配置（含凭据引用，不含明文）与角色引用登记，能力判断
//! 以服务类型支持集合的形式并入 [`ConnectionGateway::describe_capabilities`]。
//!
//! 真实实现由 app 装配（基于 connections::ConnectionService 等），独立
//! 测试注入替身。签名与 connections 已公开 API 对齐：
//! - `get` 对应 `ConnectionConfigSource::get_freezable_config`；
//! - `register_ref` / `unregister_ref` 对应 `ConnectionStore::register_role_ref`
//!   / `unregister_role_ref`；
//! - `describe_capabilities` 对应 `CapabilityDescriptor::describe`。

use async_trait::async_trait;

use crate::connections::{FreezableConfig, ServiceType};

/// 网关侧错误：roles 把它映射为 [`RolesError::Gateway`] 或
/// [`RolesError::Connection`]，错误文本不得包含凭据明文。
#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    /// 连接不存在。
    #[error("连接不存在：{0}")]
    NotFound(String),
    /// 登记目标连接不存在。
    #[error("引用登记失败，连接不存在：{0}")]
    RegisterNotFound(String),
    /// 网关操作失败（文本由实现方保证脱敏）。
    #[error("网关操作失败：{0}")]
    Failed(String),
}

/// 执行器对模型连接的能力描述（自 connections 能力概念收敛而来）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionCapabilities {
    /// 支持的模型服务类型集合；空集合表示当前无任何已确认支持。
    pub supported_service_types: Vec<ServiceType>,
}

/// roles 依赖的连接网关窄接口。
#[async_trait]
pub trait ConnectionGateway: Send + Sync {
    /// 读取连接的可冻结配置（含凭据引用，不含明文）。不存在返回 `Ok(None)`。
    async fn get(&self, id: &str) -> Result<Option<FreezableConfig>, GatewayError>;

    /// 登记角色对连接的引用。幂等：重复登记不产生重复引用。
    async fn register_ref(&self, conn_id: &str, role_id: &str) -> Result<(), GatewayError>;

    /// 解除角色对连接的引用登记。未登记时同样成功（幂等）。
    async fn unregister_ref(&self, conn_id: &str, role_id: &str) -> Result<(), GatewayError>;

    /// 读取能力描述；不可用或内容无法解释时返回
    /// `Ok(ConnectionCapabilities { supported_service_types: vec![] })`
    /// 之外的错误由调用方按「能力未知」处理，此处以 Err 传递（文本脱敏）。
    async fn describe_capabilities(&self) -> Result<ConnectionCapabilities, GatewayError>;
}
