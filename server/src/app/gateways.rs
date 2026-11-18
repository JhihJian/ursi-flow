//! 跨域网关与外部依赖装配。
//!
//! - [`RolesConnectionGateway`]：roles 声明的 [`ConnectionGateway`] 窄
//!   接口的真实实现（基于 connections 域服务）；roles SPEC 的「真实实现
//!   由 app 装配」落点。
//! - [`WorkflowRoleGateway`]：workflows 声明的 [`RoleReferenceGateway`]
//!   的真实实现，直接操作 roles 拥有的 `role_refs` 表（roles SPEC：
//!   「workflows 经本模块登记流程引用」；表结构归 roles 域，登记 SQL 由
//!   RoleStore 公开）。**装配约束**：workflows 与 roles 必须共用同一
//!   SQLite 文件（见 mod.rs「共享库装配」），否则事务内登记会写入另一
//!   个数据库。
//! 沙箱控制面的生产接入由 `app::sandbox` 装配。
//!
//! 错误文本全部复用域 Display（已脱敏），不拼接字段值。

use std::sync::Arc;

use async_trait::async_trait;

use crate::connections::ConnectionError;
use crate::roles::gateway::{
    ConnectionCapabilities, ConnectionGateway, GatewayError as RolesGatewayError,
};
use crate::workflows::GatewayError as WorkflowGatewayError;
use crate::workflows::RoleReferenceGateway;

// ---------------------------------------------------------------------------
// roles ← connections
// ---------------------------------------------------------------------------

/// roles 的连接网关真实实现：配置查询与能力描述经 [`ConnectionService`]，
/// 引用登记经 [`ConnectionStore`]（幂等，注释见 store）。
pub(crate) struct RolesConnectionGateway {
    service: Arc<crate::connections::ConnectionService>,
    store: Arc<crate::connections::ConnectionStore>,
}

impl RolesConnectionGateway {
    pub(crate) fn new(
        service: Arc<crate::connections::ConnectionService>,
        store: Arc<crate::connections::ConnectionStore>,
    ) -> Self {
        Self { service, store }
    }
}

#[async_trait]
impl ConnectionGateway for RolesConnectionGateway {
    async fn get(
        &self,
        id: &str,
    ) -> Result<Option<crate::connections::FreezableConfig>, RolesGatewayError> {
        self.service
            .get_freezable_config(id)
            .map(|c| Some(c))
            .map_err(|e| match e {
                ConnectionError::NotFound(_) => RolesGatewayError::NotFound(id.to_string()),
                other => RolesGatewayError::Failed(other.to_string()),
            })
    }

    async fn register_ref(&self, conn_id: &str, role_id: &str) -> Result<(), RolesGatewayError> {
        self.store
            .register_role_ref(conn_id, role_id)
            .map_err(|e| match e {
                ConnectionError::NotFound(_) => {
                    RolesGatewayError::RegisterNotFound(conn_id.to_string())
                }
                other => RolesGatewayError::Failed(other.to_string()),
            })
    }

    async fn unregister_ref(&self, conn_id: &str, role_id: &str) -> Result<(), RolesGatewayError> {
        self.store
            .unregister_role_ref(conn_id, role_id)
            .map_err(|e| RolesGatewayError::Failed(e.to_string()))
    }

    async fn describe_capabilities(&self) -> Result<ConnectionCapabilities, RolesGatewayError> {
        // 可以离线保存角色的连接配置，运行时另行核实执行条件。
        Ok(ConnectionCapabilities {
            supported_service_types: vec![
                crate::connections::ServiceType::OpenAiCompatible,
                crate::connections::ServiceType::Anthropic,
            ],
        })
    }
}

// ---------------------------------------------------------------------------
// workflows → roles（role_refs 表，共享库事务）
// ---------------------------------------------------------------------------

/// workflows 的角色引用网关真实实现：`role_refs` 表由 roles 迁移创建、
/// 归 roles 域拥有；workflows 在自身保存事务内经本网关登记，两域共用
/// 同一 [`crate::storage::Database`]（同文件 SQLite），保证「定义写入 +
/// 引用登记」在同一事务提交（workflows store.rs 文档化契约）。
///
/// SQL 与 roles 自身登记路径（`RoleStore::register_workflow_ref_in_tx`）
/// 逐字段一致；角色存在性在事务外由 `exists` 检查，事务内的最终一致性
/// 由 roles 删除检查（同一共享库互斥序列化）保证。
pub(crate) struct WorkflowRoleGateway {
    /// 事务外读取（角色存在性）走本网关的独立连接：共享库为 WAL 模式，
    /// 多连接并发读安全。事务内登记走 workflows 传入的事务连接。
    roles_conn: std::sync::Mutex<rusqlite::Connection>,
}

impl WorkflowRoleGateway {
    /// 打开共享库文件的独立读连接（迁移由装配序列完成，见 assembly
    /// 「存储与迁移」；首用前角色表已就绪）。
    pub(crate) fn open(path: &std::path::Path) -> Result<Self, WorkflowGatewayError> {
        Ok(Self {
            roles_conn: std::sync::Mutex::new(
                rusqlite::Connection::open(path)
                    .map_err(|e| WorkflowGatewayError::Unavailable(e.to_string()))?,
            ),
        })
    }
}

impl RoleReferenceGateway for WorkflowRoleGateway {
    fn exists(&self, role_id: &str) -> Result<bool, WorkflowGatewayError> {
        let conn = self
            .roles_conn
            .lock()
            .expect("角色引用网关读锁中毒");
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM roles WHERE id = ?1)",
                [role_id],
                |r| r.get(0),
            )
            .map_err(|e| WorkflowGatewayError::Unavailable(e.to_string()))?;
        Ok(exists)
    }

    fn register_ref(
        &self,
        tx: &rusqlite::Connection,
        role_id: &str,
        workflow_id: &str,
    ) -> Result<(), WorkflowGatewayError> {
        // 共享库约束：tx 必须来自 workflows 与 roles 共用的同一连接。
        // 传入连接来自 WorkflowStore 的 Database；本网关持有同一文件的
        // Database 句柄，仅用于存在性等事务外读取，不在事务期间触碰。
        tx.execute(
            "INSERT INTO role_refs (role_id, ref_id) VALUES (?1, ?2)
             ON CONFLICT(role_id, ref_id) DO NOTHING",
            rusqlite::params![role_id, workflow_id],
        )
        .map_err(|e| WorkflowGatewayError::Unavailable(e.to_string()))?;
        Ok(())
    }

    fn unregister_ref(
        &self,
        tx: &rusqlite::Connection,
        role_id: &str,
        workflow_id: &str,
    ) -> Result<(), WorkflowGatewayError> {
        tx.execute(
            "DELETE FROM role_refs WHERE role_id = ?1 AND ref_id = ?2",
            rusqlite::params![role_id, workflow_id],
        )
        .map_err(|e| WorkflowGatewayError::Unavailable(e.to_string()))?;
        Ok(())
    }

    fn list_refs(
        &self,
        tx: &rusqlite::Connection,
        workflow_id: &str,
    ) -> Result<Vec<String>, WorkflowGatewayError> {
        let mut stmt = tx
            .prepare("SELECT role_id FROM role_refs WHERE ref_id = ?1 ORDER BY role_id ASC")
            .map_err(|e| WorkflowGatewayError::Unavailable(e.to_string()))?;
        let rows = stmt
            .query_map([workflow_id], |r| r.get::<_, String>(0))
            .map_err(|e| WorkflowGatewayError::Unavailable(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| WorkflowGatewayError::Unavailable(e.to_string()))?;
        Ok(rows)
    }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
