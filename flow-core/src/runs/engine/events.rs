//! 事件广播：engine 内的事件总线。
//!
//! runs 将事件持久化后，以 domain 的 `TelemetryEvent` 通知 SSE 等订阅方。
//! 总线仅作实时通知，历史与断线补读以运行事件存储为准。

use std::sync::Arc;

use tokio::sync::broadcast;
use crate::domain::TelemetryEvent;

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
