//! 应用装配根：组装本地业务服务、可选的沙箱接入和协议入口。

pub mod adapters;
pub mod assembly;
pub mod config;
mod execution;
pub mod gateways;
pub mod mcp_backends;
mod sandbox;

pub use assembly::{assemble, run, App};

#[cfg(test)]
#[path = "../../tests/server_only_execution/cases.rs"]
mod server_only_execution;
pub use config::AppConfig;

#[cfg(test)]
mod tests;
