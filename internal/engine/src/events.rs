//! 事件广播：engine 内的事件总线。
//!
//! engine 与执行器产生的观测事件（节点状态、工具轨迹、日志、产物发布）统一为
//! domain 的 `TelemetryEvent`，由总线分发给订阅方（repo 持久化、api SSE 推送）。
//! 总线只负责广播，不持久化；订阅方按自身职责消费。

use std::sync::Arc;

use tokio::sync::broadcast;
use ursi_domain::TelemetryEvent;

/// 事件总线：按运行广播观测事件。
pub struct EventBus {
    tx: broadcast::Sender<(String, TelemetryEvent)>,
}

impl EventBus {
    /// 创建事件总线。
    pub fn new() -> Arc<Self> {
        let (tx, _) = broadcast::channel(1024);
        Arc::new(Self { tx })
    }

    /// 广播一条运行事件；无订阅方时事件直接丢弃，不视为错误。
    pub fn emit(&self, run_id: &str, event: TelemetryEvent) {
        let _ = self.tx.send((run_id.to_string(), event));
    }

    /// 订阅事件流，返回全量广播接收端（订阅方自行按 run_id 过滤）。
    pub fn subscribe(&self) -> broadcast::Receiver<(String, TelemetryEvent)> {
        self.tx.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self { tx }
    }
}
