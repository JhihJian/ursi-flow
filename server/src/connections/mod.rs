//! 模型连接与凭据引用管理。
//!
//! 管理可选择的模型服务连接及非敏感配置，提供受控的凭据解析入口。
//! 角色保存连接选择，runs 冻结有效配置，Agent Runtime 承担会话控制。
//!
//! 模块结构：
//! - [`model`]：`ModelConnection`、`ServiceType`、校验与交付 DTO；
//! - [`error`]：`ConnectionError`（Display 全脱敏）；
//! - [`store`]：`ConnectionStore`（rusqlite 直连自管 schema，过渡设计见文件头）；
//! - [`credential`]：`CredentialResolver` trait 与受控解析入口；
//! - [`capability`]：`CapabilityDescriptor` trait 与三态能力判断；
//! - [`service`]：配置交付（`ConnectionQuery` / `ConnectionConfigSource`）。
//!
//! 验收契约见 SPEC.md。功能与验收契约见 SPEC.md。

pub mod capability;
pub mod credential;
pub mod error;
pub mod model;
pub mod service;
pub mod store;

pub use capability::{CapabilityCheck, CapabilityDescriptor, CapabilityReport, check_capability};
pub use credential::{CredentialError, CredentialHandle, CredentialResolver, resolve_credential};
pub use error::ConnectionError;
pub use model::{
    ConnectionValidationError, ConnectionView, FreezableConfig, ModelConnection, ServiceType,
};
pub use service::{ConnectionConfigSource, ConnectionQuery, ConnectionService};
pub use store::{ConnectionChanges, ConnectionStore, NewConnection};
