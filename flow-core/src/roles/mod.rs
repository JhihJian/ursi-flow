//! 角色管理：提示词、Skills 文件包、MCP 配置和模型连接选择。
//!
//! 本模块拥有角色管理及引用约束：runs 冻结有效配置，workflows 经本模块
//! 登记流程引用，roles 依赖 connections 的能力经 [`gateway::ConnectionGateway`]
//! 注入（DESIGN「模块边界」：被调用方不回调上游域）。
//!
//! 模块结构：
//! - [`model`]：`RoleDefinition` 本域聚合与全量校验；
//! - [`skills`]：完整 Skills 文件包（入口 + 相对路径文件集合）；
//! - [`mcp`]：结构化 MCP 配置（stdio / http，敏感值必须凭据引用）；
//! - [`gateway`]：连接网关窄接口（查配置、登记引用、能力描述）；
//! - [`store`]：`RoleStore`（rusqlite 元数据 + ContentStore 内容寻址字节）；
//! - [`service`]：`RoleService`（连接校验、补偿语义、复制与定义交付）；
//! - [`error`]：`RolesError`（Display 全脱敏）。
//!
//! 验收契约见 SPEC.md。

pub mod error;
pub mod gateway;
pub mod mcp;
pub mod model;
pub mod service;
pub mod skills;
pub mod store;

pub use error::{RoleValidationError, RolesError};
pub use gateway::{ConnectionCapabilities, ConnectionGateway, GatewayError};
pub use mcp::{McpServerConfig, McpTransport};
pub use model::{DefinitionValidationError, RoleDefinition};
pub use service::{FreezableRoleDefinition, RoleService};
pub use skills::{read_package_from_dir, SkillFile, SkillPackage, SKILL_ENTRY};
pub use store::{migrations, RoleStore};

/// Runtime ACP 的执行器标识。ACP 会话实现属于 sandbox-access。
pub const RUNTIME_ACP: &str = "runtime-acp";
/// Runtime ACP 使用的固定模型配置标识。
pub const RUNTIME_PROFILE: &str = "runtime-profile";

/// 角色存储接口（兼容骨架）：仅暴露 domain `Role` 的简单读写。
/// 完整存储职责已由 [`RoleStore`] 承担（实现见 [`store::legacy`]），
/// 新代码直接使用 [`RoleStore`] / [`RoleService`]。
#[async_trait::async_trait]
pub trait RoleRepository: Send + Sync {
    async fn put_role(&self, role: &crate::domain::Role) -> Result<(), crate::storage::StoreError>;
    async fn get_role(
        &self,
        id: &str,
    ) -> Result<Option<crate::domain::Role>, crate::storage::StoreError>;
}
