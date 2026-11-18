//! 沙箱观测契约预留。
//!
//! 接入 Channel 命令与连接事件、session-service 会话事件及监督器退出
//! 事件，先提供事件摘要和计数。本 crate 为库边界，不部署独立观测服务；
//! channel 与 agent-runtime 的类型不在本 crate 依赖中，生产方与消费方
//! 仅通过本 crate 的记录类型解耦，接入新的观测消费者不改变沙箱生命周期
//! 和 agent 会话协议。
//!
//! 模块一览：
//! - [`record`]：记录模型与关联查询。
//! - [`redact`]：脱敏助手。
//! - [`collector`]：采集接口与内存/空实现。
//! - [`traffic`]：传输观测预留。
//! - [`hooks`]：生产方集成契约（app 装配时挂接）。

pub mod collector;
pub mod hooks;
pub mod record;
pub mod redact;
pub mod traffic;

pub use collector::{
    shared_in_memory, shared_noop, InMemoryCollector, NoopCollector, ObserverCollector,
    SharedCollector,
};
pub use record::{Correlation, ObserveRecord, Outcome, RecordKind, RecordSource};
pub use redact::{redact_env, redact_summary};
pub use traffic::{ChannelKind, TrafficDirection, TrafficState, TrafficSummary};
