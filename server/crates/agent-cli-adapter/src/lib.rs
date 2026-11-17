//! 具体 agent CLI 适配层。
//!
//! 实现 agent-runtime 的 `Runner` 接口：内置 mock 适配器（确定性输出，用于
//! 测试与演示）与真实 agent CLI 适配器（启动 CLI、传入提示与配置、解析输出
//! 为统一结果）。经 channel 提供的传输通道进入沙箱执行，不感知通道底层。
//! 新增 CLI 适配器无需改动 server 与 agent-runtime。

/// 适配器骨架占位：mock 与首个真实 CLI 适配在对应工作包填充。
pub struct Adapter;
