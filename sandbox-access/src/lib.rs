//! Server 的沙箱接入实现：Gateway 控制面、数据通道与 ACP 会话。

pub mod channel;
pub mod channel_impl;
pub mod gateway_v1;
pub mod session;
pub mod runtime_acp;

pub use channel_impl::{ChannelAccessConfig, ChannelGatewayImpl};
pub use gateway_v1::HttpGatewayClient;
