//! ursi-flow 主服务：按业务域组织的模块化单体。
//!
//! 业务模块为 workflows、roles、runs、artifacts、sandboxes、connections。
//! app 负责组装，transport 负责协议接入，storage 提供共享存储基础设施。
//! 各域拥有自己的存储接口，跨域经公开接口协作。独立库保持在 server/crates。
//! 会话控制由 Agent Runtime 提供，CLI Adapter 由沙箱 session-service 装配。

pub mod app;
pub mod artifacts;
pub mod connections;
pub mod roles;
pub mod runs;
pub mod sandboxes;
pub mod storage;
pub mod transport;
pub mod workflows;
