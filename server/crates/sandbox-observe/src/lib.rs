//! 沙箱观测契约预留。
//!
//! 后续接入 Channel 命令与连接事件、session-service 会话事件及监督器退出
//! 事件，先提供事件摘要和计数。本 crate 为库边界，不部署独立观测服务。
//! 当前尚未实现记录模型或采集接口。

pub struct Record;
