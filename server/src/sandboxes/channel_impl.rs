//! 文件/命令/终端通道网关（`ChannelGateway` 真实实现，基于 ursi-channel）。
//!
//! 真实链路（SPEC「文件与连接接入」）：
//! - 每次操作按 [`ChannelTarget`] 构造 [`ursi_channel::EndpointDesc`]：
//!   直连模式目标为 `ssh_host:ssh_port`；隧道模式按 Gateway 契约携带
//!   `gateway_ws_url` + Bearer token（端点名缺省 `ssh`）。
//! - 命令执行走 [`ursi_channel::ssh`]（SSH exec，合并输出与退出码），
//!   文件 put/get 走 [`ursi_channel::sftp`]（SFTP 覆盖写 + 回读校验）。
//!   与 crate 设计一致（`ChannelEnv` 文档）：每次操作建立独立 SSH 连接
//!   并即时释放，不保留会话状态；高频调用由上层复用连接自行批量执行。
//! - 隧道模式先经 [`ursi_channel::Channel::connect`] 真实建立
//!   TCP-over-WebSocket 连接（验证升级鉴权与端点授权），SSH 承载待
//!   ursi-channel 提供按连接的 SSH 接入后补齐（当前明确报错，见 Notes）。
//! - terminal 需要原生 PTY 字节流，ursi-channel 首版未提供 PTY 接入，
//!   明确返回错误（接口留位）。
//!
//! 句柄回收（SPEC「释放与连接关闭能够回收本地句柄」）：连接按操作即时
//! 释放，`close_sandbox` 语义为关闭该沙箱全部活动连接——本实现无驻留
//! 句柄，调用为幂等回收（后续访问照常按需重建连接）。

use async_trait::async_trait;
use ursi_channel::endpoint::{AuthMethod, EndpointDesc, EndpointMode};
use ursi_channel::error::ChannelError;
use ursi_channel::{sftp, ssh};

use crate::sandboxes::traits::channel::{
    ChannelAccessError, ChannelGateway, ChannelTarget, CommandOutcome, TerminalHandle,
};

/// 通道接入配置：沙箱内 SSH 服务身份与承载模式（app 装配注入）。
#[derive(Debug, Clone)]
pub struct ChannelAccessConfig {
    /// 沙箱内 SSH 服务端口。
    pub ssh_port: u16,
    /// 直连模式的目标主机（宿主映射地址或受控网络地址）；隧道模式忽略。
    pub ssh_host: String,
    /// 沙箱内服务鉴权方式（对端 sshd 的身份校验，Debug 不含凭据）。
    pub auth: AuthMethod,
    /// 承载模式：直连 TCP，或 Gateway WebSocket 隧道（地址 + 凭据）。
    pub mode: EndpointMode,
}

/// 基于 ursi-channel 的通道网关。
#[derive(Debug, Clone)]
pub struct ChannelGatewayImpl {
    config: ChannelAccessConfig,
}

impl ChannelGatewayImpl {
    /// 由接入配置构造（app 装配）。
    pub fn new(config: ChannelAccessConfig) -> Self {
        Self { config }
    }

    /// 按目标构造端点描述：直连连 host:port；隧道以 Gateway 地址与
    /// 凭据升级（端点名取自目标授权，缺省 `ssh`）。
    fn endpoint_desc(&self, target: &ChannelTarget) -> EndpointDesc {
        let endpoint_name = target
            .endpoint
            .clone()
            .unwrap_or_else(|| "ssh".to_string());
        match &self.config.mode {
            EndpointMode::Direct => {
                let mut desc =
                    EndpointDesc::direct(self.config.ssh_host.clone(), self.config.ssh_port);
                desc.sandbox_id = target.sandbox_id.clone();
                desc.endpoint_name = endpoint_name;
                desc
            }
            EndpointMode::Tunnel {
                gateway_ws_url,
                bearer_token,
            } => EndpointDesc::tunnel(
                target.sandbox_id.clone(),
                endpoint_name,
                gateway_ws_url.clone(),
                bearer_token.clone(),
            ),
        }
    }

    /// 隧道模式先建立真实隧道连接验证可达性与授权，再返回明确的
    /// 「SSH 承载待补齐」错误；直连模式直接可用。
    async fn ensure_ssh_transport(
        &self,
        target: &ChannelTarget,
    ) -> Result<(), ChannelAccessError> {
        match &self.config.mode {
            EndpointMode::Direct => Ok(()),
            EndpointMode::Tunnel { .. } => {
                // 真实执行隧道升级（Bearer/子协议/端点授权由 ursi-channel
                // 按 Gateway 契约校验），失败按可区分错误返回。
                let desc = self.endpoint_desc(target);
                let mut conn = ursi_channel::Channel::connect(desc, None)
                    .await
                    .map_err(|e| map_channel_error(e, &target.sandbox_id))?;
                let _ = conn.close().await;
                Err(ChannelAccessError::Connection(format!(
                    "沙箱 {} 的 SSH 隧道承载待 ursi-channel 提供按连接的 SSH 接入（隧道本身可达）",
                    target.sandbox_id
                )))
            }
        }
    }
}

/// ChannelError 映射为 trait 访问错误（保持可区分：鉴权/不可达/连接故障）。
fn map_channel_error(err: ChannelError, sandbox_id: &str) -> ChannelAccessError {
    match err {
        ChannelError::AuthFailed(m) => ChannelAccessError::Auth(m),
        ChannelError::Unreachable(m) => ChannelAccessError::Unreachable(m),
        ChannelError::TunnelDisabled => {
            ChannelAccessError::NotAvailable(format!("沙箱 {sandbox_id} 隧道未启用"))
        }
        ChannelError::Protocol(m) => ChannelAccessError::Connection(m),
        ChannelError::Closed => {
            ChannelAccessError::Closed(format!("沙箱 {sandbox_id} 通道已回收"))
        }
        ChannelError::Io(m) => ChannelAccessError::Connection(m),
    }
}

#[async_trait]
impl ChannelGateway for ChannelGatewayImpl {
    /// 文件通道：SFTP put 覆盖写后回读校验（SPEC：回读保持完整），
    /// 返回回读字节长度。
    async fn open_file_channel(
        &self,
        target: &ChannelTarget,
        path: &str,
        bytes: &[u8],
    ) -> Result<usize, ChannelAccessError> {
        self.ensure_ssh_transport(target).await?;
        let result = sftp::put_auth(
            &self.config.ssh_host,
            self.config.ssh_port,
            &self.config.auth,
            path,
            bytes,
        )
        .await;
        if let Err(e) = result {
            return Err(map_channel_error(e, &target.sandbox_id));
        }
        let read_back = sftp::get_auth(
            &self.config.ssh_host,
            self.config.ssh_port,
            &self.config.auth,
            path,
        )
        .await
        .map_err(|e| map_channel_error(e, &target.sandbox_id))?;
        if read_back != bytes {
            return Err(ChannelAccessError::Connection(format!(
                "回读内容不一致：写入 {} 字节，回读 {} 字节",
                bytes.len(),
                read_back.len()
            )));
        }
        Ok(read_back.len())
    }

    /// 命令通道：SSH exec，返回合并输出与退出状态
    /// （SPEC：命令返回输出与退出状态）。
    async fn open_exec_channel(
        &self,
        target: &ChannelTarget,
        cmd: &str,
    ) -> Result<CommandOutcome, ChannelAccessError> {
        self.ensure_ssh_transport(target).await?;
        let (exit_code, output) = ssh::exec_auth(
            &self.config.ssh_host,
            self.config.ssh_port,
            &self.config.auth,
            cmd,
        )
        .await
        .map_err(|e| map_channel_error(e, &target.sandbox_id))?;
        Ok(CommandOutcome { output, exit_code })
    }

    /// 交互终端：需要原生 PTY 字节流，ursi-channel 首版未提供 PTY 接入，
    /// 明确返回错误（接口留位，接入后按目标端点建立原生协议连接）。
    async fn open_terminal(
        &self,
        target: &ChannelTarget,
    ) -> Result<Box<dyn TerminalHandle>, ChannelAccessError> {
        Err(ChannelAccessError::Connection(format!(
            "沙箱 {} 的 terminal 需要原生 PTY 字节流，ursi-channel 首版未提供 PTY 接入",
            target.sandbox_id
        )))
    }

    /// 回收一次运行的通道句柄：连接按操作即时释放，本实现无驻留句柄，
    /// 回收为幂等操作（连接关闭不被当作远端任务取消，运行侧无感知）。
    async fn close_sandbox(&self, _sandbox_id: &str) {}
}

#[cfg(test)]
mod tests;
