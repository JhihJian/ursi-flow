//! MCP 工具面：面向 agent 暴露平台工具。
//!
//! 协议无关的工具注册域 + 进程内 JSON-RPC 式调用骨架。同一 server
//! 骨架下的三个工具注册域：运维域（沙箱与网关操作）、控制域（流程
//! 与运行操作）、内部工具域（运行上下文内的产物与状态工具，注入
//! run/node 身份）。
//!
//! ## 边界
//!
//! - 本 crate 不引入完整 MCP 协议栈，不解析 MCP 报文、不做协议握手、
//!   不处理 SSE/stdio 传输。真实 MCP 传输归 server transport 联合验收。
//! - 域操作不直接实现业务，经 [`backend`] 注入的窄契约访问平台状态，
//!   真实实现由 server 装配（transport/app 模块完成组装）。
//! - 具体工具集随流程需要逐步填充，当前为骨架首批工具。
//!
//! ## 结构
//!
//! - [`tool`]：[`Tool`](tool::Tool)、[`ToolHandler`](tool::ToolHandler)、工具清单条目。
//! - [`backend`]：[`OpsBackend`](backend::OpsBackend)、[`ControlBackend`](backend::ControlBackend)、[`InternalBackend`](backend::InternalBackend) 注入契约与只读视图类型。
//! - [`domains`]：[`Domain`](domains::Domain)（运维/控制/内部三域工具生成与路由）、[`DomainId`](domains::DomainId)。
//! - [`server`]：[`McpServer`](server::McpServer) 装配、list_tools、invoke。
//! - [`context`]：[`InvocationContext`](context::InvocationContext) 与身份参数校验。
//! - [`error`]：[`ToolError`](error::ToolError)、[`AssemblyError`](error::AssemblyError)、[`BackendFailure`](error::BackendFailure)。
//!
//! 录制式测试替身 backend 见 [`stubs`] 模块，供集成测试与下游模块测试复用。

mod backend;
mod context;
mod domains;
mod error;
mod server;
mod tool;

/// 录制式替身 backend：供集成测试与下游模块测试注入，
/// 记录调用并返回确定性数据，不实现任何真实业务。
pub mod stubs;

pub use backend::{
    ArtifactView, ControlBackend, GatewayStatus, InternalBackend, InternalBackendError,
    NodeSnapshot, OpsBackend, OpsOutcome, RunSummary, SandboxSummary,
};
pub use context::{detect_identity_args, InvocationContext, FORBIDDEN_IDENTITY_KEYS};
pub use domains::{Domain, DomainId};
pub use error::{AssemblyError, BackendFailure, ToolError};
pub use server::McpServer;
pub use tool::{fn_handler, Tool, ToolDescriptor, ToolHandler, ToolOutput};
