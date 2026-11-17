//! 角色管理：提示词、Skills 文件、MCP 配置和模型连接选择。
//!
//! 本模块拥有角色管理及引用约束，运行创建时由 runs 冻结有效配置。
//! 当前保留角色读写骨架，完整管理与验收契约见 SPEC.md。

use async_trait::async_trait;
use ursi_domain::Role;

use crate::storage::StoreError;

/// 角色存储接口，仅暴露本域数据操作。
#[async_trait]
pub trait RoleRepository: Send + Sync {
    async fn put_role(&self, role: &Role) -> Result<(), StoreError>;
    async fn get_role(&self, id: &str) -> Result<Option<Role>, StoreError>;
}
