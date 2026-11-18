//! 应用配置：监听地址、存储位置、静态资源与运行参数。
//!
//! 装配来源有两个：
//! - 环境变量（生产入口 [`super::run`] 使用，全部可选、有默认值或含义）；
//! - 直接构造（测试与独立验收使用，见 [`AppConfig::for_test`]）。
//!
//! Gateway 地址和密钥仅供装配使用；配置诊断不输出两者的明文。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

/// 可选的 Gateway 接入配置。地址也可能包含敏感信息。
#[derive(Clone)]
pub struct GatewayConfig {
    pub(super) url: String,
    pub(super) key: String,
    pub(super) timeout: Duration,
}

impl GatewayConfig {
    pub fn new(url: String, key: String, timeout: Duration) -> Self {
        Self { url, key, timeout }
    }

    fn from_pair(url: Option<String>, key: Option<String>) -> Result<Option<Self>, String> {
        match (url, key) {
            (None, None) => Ok(None),
            (Some(url), Some(key)) => Ok(Some(Self::new(url, key, Duration::from_secs(30)))),
            _ => Err("URSI_GATEWAY_URL 与 URSI_GATEWAY_KEY 必须同时配置或同时省略".into()),
        }
    }
}

impl std::fmt::Debug for GatewayConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewayConfig")
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

/// 应用装配配置。
#[derive(Debug, Clone)]
pub struct AppConfig {
    /// HTTP 监听地址。产品默认 0.0.0.0:8080，测试用 127.0.0.1:0。
    pub listen_addr: SocketAddr,
    /// 数据目录：各域 SQLite 与内容存储根都在其下。
    pub data_dir: PathBuf,
    /// 静态页面根目录；None 时静态兜底返回 404。
    pub static_root: Option<PathBuf>,
    /// 未配置 Gateway 时仍可启动并处理离线操作。
    pub gateway: Option<GatewayConfig>,
    /// 管理员私有目录，每个运行一份 `<run_id>.json` ACP 身份。见 sandbox-access/ACP.md。
    pub acp_bindings_dir: Option<PathBuf>,
    /// 租约 TTL。测试可调小以验证租约接管。
    pub lease_ttl: Duration,
    /// 租约恢复扫描间隔。
    pub lease_scan_interval: Duration,
    /// 资源收尾重试扫描间隔。
    pub cleanup_retry_interval: Duration,
    /// 收到关闭信号后，等待运行服务收尾的超时。
    pub shutdown_timeout: Duration,
}

impl AppConfig {
    /// 产品默认配置：监听 0.0.0.0:8080，数据落 `./data`。
    pub fn default_prod() -> Result<Self, String> {
        Ok(Self {
            listen_addr: SocketAddr::new(
                std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
                8080,
            ),
            data_dir: PathBuf::from("data"),
            static_root: None,
            gateway: None,
            acp_bindings_dir: None,
            lease_ttl: Duration::from_secs(300),
            lease_scan_interval: Duration::from_secs(10),
            cleanup_retry_interval: Duration::from_secs(15),
            shutdown_timeout: Duration::from_secs(10),
        })
    }

    /// 测试配置：127.0.0.1 随机端口、临时风格数据目录（调用方给定）、
    /// 短间隔扫描，便于快速验证生命周期。
    pub fn for_test(data_dir: PathBuf) -> Self {
        Self {
            listen_addr: SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 0),
            data_dir,
            static_root: None,
            gateway: None,
            acp_bindings_dir: None,
            lease_ttl: Duration::from_secs(60),
            lease_scan_interval: Duration::from_millis(200),
            cleanup_retry_interval: Duration::from_millis(200),
            shutdown_timeout: Duration::from_secs(5),
        }
    }

    /// 从环境变量读取配置（全部可选）：
    /// - `URSI_LISTEN_ADDR`：监听地址，默认 0.0.0.0:8080；非法地址明确报错；
    /// - `URSI_DATA_DIR`：数据目录，默认 `./data`；
    /// - `URSI_STATIC_ROOT`：静态资源根目录，缺省不启用静态兜底；
    /// - `URSI_GATEWAY_URL` 与 `URSI_GATEWAY_KEY`：必须成对设置，空白视为未设置。
    pub fn from_env() -> Result<Self, String> {
        reject_legacy_acp_env()?;
        let mut config = Self::default_prod()?;
        if let Some(raw) = non_empty_env("URSI_LISTEN_ADDR")? {
            config.listen_addr = raw.parse::<SocketAddr>().map_err(|_| {
                format!("URSI_LISTEN_ADDR 不是合法监听地址（形如 0.0.0.0:8080）：{raw}")
            })?;
        }
        if let Some(raw) = non_empty_env("URSI_DATA_DIR")? {
            config.data_dir = PathBuf::from(raw);
        }
        if let Some(raw) = non_empty_env("URSI_STATIC_ROOT")? {
            config.static_root = Some(PathBuf::from(raw));
        }
        config.acp_bindings_dir = non_empty_env("URSI_ACP_BINDINGS_DIR")?.map(PathBuf::from);
        config.gateway = GatewayConfig::from_pair(
            non_empty_env("URSI_GATEWAY_URL")?,
            non_empty_env("URSI_GATEWAY_KEY")?,
        )?;
        Ok(config)
    }

    /// 各域共享 SQLite 文件路径。
    pub fn shared_db_path(&self) -> PathBuf {
        self.data_dir.join("ursi.db")
    }

    /// connections 域自管库路径。
    pub fn connections_db_path(&self) -> PathBuf {
        self.data_dir.join("connections.db")
    }

    /// runs 域自管库路径。
    pub fn runs_db_path(&self) -> PathBuf {
        self.data_dir.join("runs.db")
    }

    /// sandboxes 域自管库路径。
    pub fn sandboxes_db_path(&self) -> PathBuf {
        self.data_dir.join("sandboxes.db")
    }

    /// 内容存储根目录（skills 文件包等，内容寻址）。
    pub fn content_root(&self) -> PathBuf {
        self.data_dir.join("content")
    }
}

/// 仅检查旧变量是否存在。即使值为空或不是 Unicode，也不能悄悄切换执行身份。
pub(super) fn reject_legacy_acp_env() -> Result<(), String> {
    for key in [
        "URSI_ACP_URL",
        "URSI_SESSION_TOKEN",
        "URSI_SESSION_TOKEN_FILE",
        "URSI_CLIENT_TIMEOUT_SECS",
    ] {
        if std::env::var_os(key).is_some() {
            return Err(format!(
                "{key} 已不再用于 Server 执行。请移除旧 ACP 环境变量，迁移到 URSI_GATEWAY_URL、URSI_GATEWAY_KEY 和 URSI_ACP_BINDINGS_DIR，为每个运行配置独立身份"
            ));
        }
    }
    Ok(())
}

fn non_empty_env(key: &str) -> Result<Option<String>, String> {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{key} 不是有效的 Unicode 文本")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_pair_is_optional_and_diagnostics_hide_both_values() {
        let url = "https://private-gateway.example";
        let key = "private-test-token";
        let mut config = AppConfig::for_test(PathBuf::new());
        assert!(config.gateway.is_none());
        assert!(GatewayConfig::from_pair(None, None).unwrap().is_none());
        for (url_only, key_only) in [(Some(url.into()), None), (None, Some(key.into()))] {
            let err = GatewayConfig::from_pair(url_only, key_only).unwrap_err();
            assert!(err.contains("URSI_GATEWAY_URL") && err.contains("URSI_GATEWAY_KEY"));
            assert!(!err.contains(url) && !err.contains(key));
        }
        config.gateway = GatewayConfig::from_pair(Some(url.into()), Some(key.into())).unwrap();
        let gateway = config.gateway.as_ref().unwrap();
        assert_eq!(gateway.url, url);
        assert_eq!(gateway.key, key);
        let debug = format!("{config:?}");
        assert!(!debug.contains(url) && !debug.contains(key));
    }
}
