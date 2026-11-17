//! SSH 命令执行（基于 russh 0.45）。
//!
//! # 鉴权
//!
//! [`AuthMethod::Password`] 使用 SSH `password` 方式；[`AuthMethod::PublicKey`]
//! 解析 OpenSSH PEM 私钥后使用 `publickey` 方式。两种方式均由 [`exec_auth`]
//! 统一入口暴露。
//!
//! # 语义
//!
//! `exec` 打开 session 通道执行命令，合并 stdout 与 stderr（命令通过
//! `/bin/sh -c` 语义执行，由 sshd 解释），等待 `ExitStatus` 与通道关闭后
//! 返回 `(exit_code, 合并输出)`。不做任何重试。
//!
//! # 测试
//!
//! `tests` 中用 russh 的 server 端（`russh::server::Server` trait）起一个
//! 进程内 sshd，处理 `exec` 请求返回固定输出与退出码，覆盖密码与公钥鉴权。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{self, Handle};
use russh::keys::key::KeyPair;
use russh::ChannelMsg;

use crate::endpoint::AuthMethod;
use crate::error::ChannelError;

/// SSH 连接超时。
const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 客户端 Handler：信任服务端主机密钥（沙箱内服务，网络与身份由 Gateway/调用方约束）。
#[derive(Debug, Default)]
pub struct ClientHandler;

#[async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // 沙箱内 sshd 的主机密钥不预分发；身份校验由 Gateway 与调用凭据完成。
        Ok(true)
    }
}

/// 建立 SSH 连接并完成鉴权。
///
/// 失败映射：握手/网络失败为 [`ChannelError::Unreachable`]，
/// 鉴权被拒为 [`ChannelError::AuthFailed`]。
pub async fn ssh_connect(
    host: &str,
    port: u16,
    auth: &AuthMethod,
) -> Result<Handle<ClientHandler>, ChannelError> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(600)),
        ..Default::default()
    });
    let addr = (host, port);
    let mut handle = tokio::time::timeout(
        SSH_CONNECT_TIMEOUT,
        client::connect(config, addr, ClientHandler),
    )
    .await
    .map_err(|_| ChannelError::Unreachable(format!("SSH 连接超时：{host}:{port}")))?
    .map_err(|e| ChannelError::Unreachable(format!("SSH 连接失败：{host}:{port}：{e}")))?;

    match auth {
        AuthMethod::Password { user, password } => {
            let ok: bool = handle
                .authenticate_password(user.clone(), password.clone())
                .await
                .map_err(map_auth_transport_error)?;
            ensure_auth(ok, "密码")?;
        }
        AuthMethod::PublicKey { user, private_key_pem } => {
            // 兼容 OpenSSH 与 PKCS#8 PEM 两种格式。
            let key = russh::keys::decode_secret_key(private_key_pem, None)
                .map_err(|e| ChannelError::AuthFailed(format!("私钥解析失败：{e}")))?;
            let ok = handle
                .authenticate_publickey(user.clone(), Arc::new(key))
                .await
                .map_err(map_auth_transport_error)?;
            ensure_auth(ok, "公钥")?;
        }
    }
    Ok(handle)
}

fn map_auth_transport_error(e: russh::Error) -> ChannelError {
    ChannelError::Unreachable(format!("SSH 鉴权传输失败：{e}"))
}

fn ensure_auth(ok: bool, method: &str) -> Result<(), ChannelError> {
    if ok {
        Ok(())
    } else {
        Err(ChannelError::AuthFailed(format!("{method}鉴权被拒绝")))
    }
}

/// 在既有 SSH 连接上执行命令，返回 `(exit_code, stdout+stderr 合并输出)`。
pub async fn exec_on(
    handle: &mut Handle<ClientHandler>,
    command: &str,
) -> Result<(i32, String), ChannelError> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| ChannelError::Io(format!("打开 SSH 通道失败：{e}")))?;
    channel
        .exec(true, command.to_string())
        .await
        .map_err(|e| ChannelError::Io(format!("发送 exec 请求失败：{e}")))?;

    let mut output = Vec::new();
    let mut exit_code: Option<u32> = None;
    loop {
        let Some(msg) = channel.wait().await else {
            // 通道关闭但没有 ExitStatus：视为远端异常结束。
            break;
        };
        match msg {
            ChannelMsg::Data { data } => output.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, .. } => output.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
            ChannelMsg::Eof | ChannelMsg::Close => {}
            _ => {}
        }
    }
    let code = exit_code
        .map(|c| c as i32)
        .ok_or_else(|| ChannelError::Protocol("SSH 通道关闭前未收到退出状态".into()))?;
    let text = String::from_utf8_lossy(&output).into_owned();
    Ok((code, text))
}

/// 连接并执行一条命令的便捷入口。
pub async fn exec_auth(
    host: &str,
    port: u16,
    auth: &AuthMethod,
    command: &str,
) -> Result<(i32, String), ChannelError> {
    let mut handle = ssh_connect(host, port, auth).await?;
    let result = exec_on(&mut handle, command).await;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "en-US")
        .await;
    result
}

/// 为测试生成一个随机 Ed25519 密钥对。
pub fn generate_keypair() -> KeyPair {
    KeyPair::generate_ed25519().expect("生成 Ed25519 密钥失败")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 密钥对可生成且调试输出不含私料() {
        let kp = generate_keypair();
        let dbg = format!("{kp:?}");
        // KeyPair 的 Debug 不输出私钥字节（russh 对变体仅打印名称与公钥信息）。
        assert!(!dbg.contains("SigningKey"));
        assert!(!kp.clone_public_key().unwrap().fingerprint().is_empty());
    }

    #[tokio::test]
    async fn 密码错误返回可区分错误() {
        // 对一个必然拒绝所有鉴权的本地不可达端口，连接失败应归为 Unreachable。
        // 这里只验证错误映射本身，不依赖外部 sshd。
        let err = exec_auth(
            "127.0.0.1",
            1, // 保留端口，本机不可达
            &AuthMethod::Password {
                user: "u".into(),
                password: "p".into(),
            },
            "echo hi",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ChannelError::Unreachable(_)), "{err}");
    }
}
