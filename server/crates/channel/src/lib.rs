//! 通道控制层：运行中交互与内容传输的独立通道模块。
//!
//! 职责是连接与帧传输（字节层）：SSH 命令执行、SFTP 文件传输、Agent ACP
//! 会话传输、终端与 code-server、Chromium CDP、noVNC、应用预览端口。
//! 会话语义（ACP JSON-RPC、agent 控制接口）在 agent-runtime，本模块只管
//! 建立连接、传输字节、生命周期绑定与鉴权。
//!
//! 骨架阶段仅保留模块边界；trait 设计待运行面传输契约
//! （sandbox-gateway/CONTRACT.md C2）定稿后展开，通道清单与契约见 SPEC。

pub struct Channel;
