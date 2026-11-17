//! 过程可观测：事件采集与订阅。
//!
//! 接收 engine 与执行器上报的观测事件（节点状态、工具轨迹、日志、产物发布），
//! 统一为 `TelemetryEvent` 契约，并提供订阅接口把事件推送给 api 与 web。
//! 本 crate 只负责采集与转发，持久化由 repo 承担。

use async_trait::async_trait;
use ursi_domain::TelemetryEvent;

/// 事件上报入口：接收并规范化观测事件。
#[async_trait]
pub trait EventSink: Send + Sync {
    async fn emit(&self, run_id: &str, event: TelemetryEvent);
}

/// 事件订阅：按运行订阅事件流。
#[async_trait]
pub trait Subscriber: Send + Sync {
    /// 订阅一个运行的事件流，返回逐条事件。
    async fn subscribe(&self, run_id: String) -> Result<Box<dyn EventStream>, ObserveError>;
}

/// 事件流。
#[async_trait]
pub trait EventStream: Send + Sync {
    /// 读取下一条事件，流结束时返回 None。
    async fn next(&mut self) -> Option<TelemetryEvent>;
}

/// 观测错误。
#[derive(Debug, thiserror::Error)]
pub enum ObserveError {
    #[error("订阅失败：{0}")]
    Subscribe(String),
}
