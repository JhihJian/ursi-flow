//! ursi-flow 主服务：应用装配和 HTTP、SSE、MCP 协议接入。

pub mod app;
pub mod mcp;
pub mod transport;

pub use flow_core::{artifacts, connections, roles, runs, sandboxes, storage, workflows};
