//! Server Channel：server 内连接库。
//!
//! 负责 SSH/SFTP、ACP 传输及原生 HTTP/WebSocket 服务接入，通过直连或
//! Gateway 隧道承载相同上层协议。只管理本地连接，对端会话由 session-service
//! 管理。当前为模块骨架，连接实现和观测接入口尚未实现。

pub struct Channel;
