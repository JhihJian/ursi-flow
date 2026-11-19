//! Sandbox Gateway：独立资源控制面。
//!
//! gateway_api 接入请求，lifecycle 管操作意图与持久化对账，driver 适配基础
//! 设施，tunnel 提供可选字节中继。各模块同属一个 crate，可独立启动和验收。

pub mod driver;
pub mod gateway_api;
pub mod lifecycle;
pub mod models;
pub mod registry;
pub mod tunnel;
