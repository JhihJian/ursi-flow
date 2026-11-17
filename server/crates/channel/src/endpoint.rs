//! 端点描述与鉴权方式。
//!
//! [`EndpointDesc`] 描述一次连接目标：沙箱内主机与端口，以及承载方式
//! （直连 TCP 或经 Gateway WebSocket 隧道）。端点名仅隧道模式需要，
//! Gateway 只接受已声明的端点名，不接受任意 host/URL。

use std::fmt;

/// 端点承载模式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndpointMode {
    /// 直连 TCP（网络可达沙箱端口时使用）。
    Direct,
    /// 经 Gateway TCP-over-WebSocket 隧道（协议 `ursi-tcp-v1`）。
    Tunnel {
        /// Gateway 基地址，如 `ws://gateway:8080`。
        gateway_ws_url: String,
        /// Gateway Bearer 凭据，不落日志。
        bearer_token: String,
    },
}

/// 端点鉴权方式（对端服务自身的身份校验，如 sshd）。
#[derive(Clone)]
pub enum AuthMethod {
    /// 密码鉴权。
    Password {
        /// 用户名。
        user: String,
        /// 密码明文，仅内存持有，不落日志。
        password: String,
    },
    /// 公钥鉴权。
    PublicKey {
        /// 用户名。
        user: String,
        /// 私钥内容（OpenSSH 格式）。
        private_key_pem: String,
    },
}

impl fmt::Debug for AuthMethod {
    /// 调试输出不包含凭据明文。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthMethod::Password { user, .. } => {
                write!(f, "Password {{ user: {user}, password: *** }}")
            }
            AuthMethod::PublicKey { user, .. } => {
                write!(f, "PublicKey {{ user: {user}, private_key: *** }}")
            }
        }
    }
}

/// 端点描述：连接目标与承载方式。
#[derive(Debug, Clone)]
pub struct EndpointDesc {
    /// 目标沙箱 ID（隧道 URL 路径使用）。
    pub sandbox_id: String,
    /// 已声明端点名（隧道模式必填，直连模式可空）。
    pub endpoint_name: String,
    /// 目标服务端口。
    pub port: u16,
    /// 目标服务主机名或 IP。
    pub host: String,
    /// 承载模式。
    pub mode: EndpointMode,
}

impl EndpointDesc {
    /// 构造直连端点。
    pub fn direct(host: impl Into<String>, port: u16) -> Self {
        Self {
            sandbox_id: String::new(),
            endpoint_name: String::new(),
            port,
            host: host.into(),
            mode: EndpointMode::Direct,
        }
    }

    /// 构造隧道端点。
    pub fn tunnel(
        sandbox_id: impl Into<String>,
        endpoint_name: impl Into<String>,
        gateway_ws_url: impl Into<String>,
        bearer_token: impl Into<String>,
    ) -> Self {
        Self {
            sandbox_id: sandbox_id.into(),
            endpoint_name: endpoint_name.into(),
            port: 0,
            host: String::new(),
            mode: EndpointMode::Tunnel {
                gateway_ws_url: gateway_ws_url.into(),
                bearer_token: bearer_token.into(),
            },
        }
    }
}
