//! Agent CLI 适配层。
//!
//! 真实适配器由沙箱内 session-service 装配，负责本地 CLI 进程控制、能力
//! 配置渲染与输出解析。mock 用于契约测试。当前尚未实现具体适配器。

pub struct Adapter;
