//! 应用配置：监听地址、存储位置、静态资源与运行参数。
//!
//! 装配来源有两个：
//! - 环境变量（生产入口 [`super::run`] 使用，全部可选、有默认值或含义）；
//! - 直接构造（测试与独立验收使用，见 [`AppConfig::for_test`]）。
//!
//! 脱敏边界：本结构不含任何凭据字段（凭据以引用形态存在于 connections
//! 域内），Debug 输出与启动日志可整体打印。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

/// 应用装配配置。
#[derive(Debug, Clone)]
pub struct AppConfig {
    /// HTTP 监听地址。产品默认 0.0.0.0:8080，测试用 127.0.0.1:0。
    pub listen_addr: SocketAddr,
    /// 数据目录：各域 SQLite 与内容存储根都在其下。
    pub data_dir: PathBuf,
    /// 静态页面根目录；None 时静态兜底返回 404。
    pub static_root: Option<PathBuf>,
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
            listen_addr: SocketAddr::new(
                std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                0,
            ),
            data_dir,
            static_root: None,
            lease_ttl: Duration::from_secs(60),
            lease_scan_interval: Duration::from_millis(200),
            cleanup_retry_interval: Duration::from_millis(200),
            shutdown_timeout: Duration::from_secs(5),
        }
    }

    /// 从环境变量读取配置（全部可选）：
    /// - `URSI_LISTEN_ADDR`：监听地址，默认 0.0.0.0:8080；非法地址明确报错；
    /// - `URSI_DATA_DIR`：数据目录，默认 `./data`；
    /// - `URSI_STATIC_ROOT`：静态资源根目录，缺省不启用静态兜底。
    pub fn from_env() -> Result<Self, String> {
        let mut config = Self::default_prod()?;
        if let Some(raw) = non_empty_env("URSI_LISTEN_ADDR") {
            config.listen_addr = raw
                .parse::<SocketAddr>()
                .map_err(|_| format!("URSI_LISTEN_ADDR 不是合法监听地址（形如 0.0.0.0:8080）：{raw}"))?;
        }
        if let Some(raw) = non_empty_env("URSI_DATA_DIR") {
            config.data_dir = PathBuf::from(raw);
        }
        if let Some(raw) = non_empty_env("URSI_STATIC_ROOT") {
            config.static_root = Some(PathBuf::from(raw));
        }
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

fn non_empty_env(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => None,
    }
}
