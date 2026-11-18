//! 外部依赖窄接口：Gateway 控制面客户端与文件/命令通道网关。
//!
//! DESIGN「依赖方向与公开边界」：sandboxes 通过 Gateway 契约与 Channel
//! 接入资源和连接。本模块定义 server 内的窄接口，真实实现由 app 装配
//! （HTTP 客户端与 channel crate），独立测试注入替身，不引入 HTTP 客户端。

pub mod channel;
pub mod gateway;

pub use channel::{ChannelAccessError, ChannelGateway, ChannelTarget, CommandOutcome, TerminalHandle};
pub use gateway::GatewayClient;
