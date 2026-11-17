//! 沙箱控制面（Sandbox Gateway）。
//!
//! 独立进程，管理沙箱容器的生命周期：REST 接口、生命周期编排与恢复对账、
//! 驱动抽象（fake/docker）、状态存储。与 kernel 仅通过版本化 REST 契约耦合，
//! 不依赖 internal/* 下的任何 crate。

pub mod models;
pub mod driver;
pub mod store;
pub mod service;
pub mod api;
