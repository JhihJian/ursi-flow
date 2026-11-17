//! HTTP 接入、鉴权、参数校验、错误映射与 WebSocket 升级。
//!
//! 生命周期操作交给 lifecycle，字节中继交给 tunnel。

/// 接入层骨架，尚未提供 HTTP 服务。
pub struct Api;
