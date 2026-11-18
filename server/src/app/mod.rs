//! 应用装配根：读取配置、创建各模块实现、启动后台任务和协议服务，
//! 并协调关闭。二进制入口只调用 [`assembly::run`]。
//!
//! 模块结构：
//! - [`config`]：`AppConfig`（环境变量与直接构造两个来源）；
//! - [`gateways`]：跨域网关真实实现（roles←connections、workflows→roles）
//!   与 Gateway/通道占位实现；
//! - [`adapters`]：transport 注入接口的域适配器（含错误映射）；
//! - [`mcp_backends`]：MCP 三域后端的装配适配器；
//! - [`assembly`]：`assemble` / `App`（就绪、有序关闭）与 `run` 入口。
//!
//! ## 本阶段交付边界（占位与缺口，供联合验收排期）
//!
//! 完整对接：workflows、roles、connections、runs（创建/启动/审批/打回/
//! 取消/读取/事件）、sandboxes（prepare/status/release 的服务路径）、
//! MCP 三域后端、静态资源。
//!
//! 占位与缺口（接口现状，不在 app 内修补）：
//! - Gateway 控制面与通道网关为占位实现（[`gateways`]），沙箱准备/释放
//!   会收到明确错误，不伪造资源状态；
//! - 脚本节点执行器为占位（明确失败）；
//! - `RunRepository` 无运行列举/按清理状态列举查询，transport 与 MCP 的
//!   「无过滤列举」与租约恢复、收尾重试扫描清单没有事实来源，相应入口
//!   返回明确错误或空转（不伪造数据）；
//! - `get_run` / 单产物读取无按 ID 索引路径的域接口，按上述同一缺口处理。
//!
//! 验收契约见 SPEC.md；测试见 [`tests`]（真实 SQLite + 进程内 HTTP）。
//! Runtime ACP 的真实 Flow 核验入口见 `server/REAL-RUNTIME-ACP.md` 与
//! `server/tests/real_runtime_acp.rs`，该入口只在显式 opt-in 下运行。

pub mod adapters;
pub mod assembly;
pub mod config;
pub mod gateways;
pub mod mcp_backends;

pub use assembly::{assemble, run, App};
pub use config::AppConfig;

#[cfg(test)]
mod tests;
