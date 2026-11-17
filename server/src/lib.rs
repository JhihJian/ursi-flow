//! ursi-flow server：HTTP/WebSocket/MCP 接入、应用服务、工作流引擎与存储。
//!
//! 单 crate 内模块分层（对照 grasp server/internal 的组织）：
//! - `handlers`：HTTP/SSE 接入与参数校验（原 internal/api）
//! - `engine`：流程调度、状态机、审批打回、租约恢复、事件总线（原 internal/engine）
//! - `database`：存储接口与 SQLite（原 internal/repo）
//! - `sandbox`：kernel 侧沙箱生命周期编排与 gateway 客户端（原 internal/sandbox）
//!
//! 依赖纪律：server 是依赖汇点，仅它依赖 channel / agent-runtime /
//! sandbox-gateway 客户端；channel 与 agent-runtime 不得反向依赖 server。
//! agent 会话协议语义在 agent-runtime，字节传输在 channel，具体 CLI 适配
//! 在 agent-cli-adapter。

pub mod database;
pub mod engine;
pub mod handlers;
pub mod sandbox;
