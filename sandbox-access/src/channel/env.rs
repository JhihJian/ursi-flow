//! `flow_core::domain::ExecutionEnv` 的 Channel 适配：[`ChannelEnv`]。
//!
//! - [`ChannelEnv::exec`]：走 SSH exec，返回 `(exit_code, 合并输出)`。
//! - [`ChannelEnv::write_file`] / [`ChannelEnv::read_file`]：走 SFTP put/get。
//!
//! 错误映射：连接已关闭 → [`EnvError::Other`]（含 `ChannelError::Closed`）；
//! SFTP 文件不存在 → [`EnvError::FileNotFound`]；其余 SSH/SFTP 故障 →
//! [`EnvError::Exec`] / [`EnvError::Other`]。测试由进程内 SSH server 集成
//! 测试支撑（见 `tests/channel_env.rs`）。

use async_trait::async_trait;
use flow_core::domain::EnvError;

use crate::channel::endpoint::AuthMethod;
use crate::channel::error::ChannelError;
use crate::channel::sftp;
use crate::channel::ssh;

/// 基于 Channel 的沙箱执行环境。
///
/// 每次操作建立独立 SSH 连接并即时释放（无会话状态），适合低频控制面
/// 操作；高频调用应由上层复用连接句柄自行批量执行。
#[derive(Debug, Clone)]
pub struct ChannelEnv {
    host: String,
    port: u16,
    auth: AuthMethod,
}

impl ChannelEnv {
    /// 构造环境：SSH 服务地址与鉴权方式。
    pub fn new(host: impl Into<String>, port: u16, auth: AuthMethod) -> Self {
        Self {
            host: host.into(),
            port,
            auth,
        }
    }
}

impl From<ChannelError> for EnvError {
    fn from(err: ChannelError) -> Self {
        match err {
            ChannelError::Protocol(msg) if msg.contains("文件不存在") => {
                EnvError::FileNotFound(msg)
            }
            // SSH exec 的非零退出不算环境故障，exec 正常返回 (code, output)；
            // 这里只映射传输/协议层失败。
            ChannelError::Closed => EnvError::Other("连接已关闭".into()),
            other => EnvError::Other(other.to_string()),
        }
    }
}

#[async_trait]
impl flow_core::domain::ExecutionEnv for ChannelEnv {
    async fn exec(&self, cmd: &str) -> Result<(i32, String), EnvError> {
        ssh::exec_auth(&self.host, self.port, &self.auth, cmd)
            .await
            .map_err(Into::into)
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> Result<(), EnvError> {
        sftp::put_auth(&self.host, self.port, &self.auth, path, content)
            .await
            .map_err(Into::into)
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, EnvError> {
        sftp::get_auth(&self.host, self.port, &self.auth, path)
            .await
            .map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 错误映射区分文件不存在与其他故障() {
        let e = ChannelError::Protocol("文件不存在：/a/b".into());
        let mapped: EnvError = e.into();
        assert!(matches!(mapped, EnvError::FileNotFound(_)), "{mapped}");

        let e = ChannelError::Closed;
        let mapped: EnvError = e.into();
        assert!(matches!(mapped, EnvError::Other(_)), "{mapped}");

        let e = ChannelError::Io("断开".into());
        let mapped: EnvError = e.into();
        assert!(matches!(mapped, EnvError::Other(_)), "{mapped}");
    }

    #[test]
    fn 调试输出不含凭据() {
        let env = ChannelEnv::new(
            "127.0.0.1",
            22,
            AuthMethod::Password {
                user: "root".into(),
                password: "hunter2".into(),
            },
        );
        let dbg = format!("{env:?}");
        assert!(!dbg.contains("hunter2"), "凭据泄漏：{dbg}");
    }
}
