use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    Unavailable(String),
    #[error("{0}")]
    Internal(String),
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Public,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PortSpec {
    pub name: String,
    pub port: u16,
    pub visibility: Visibility,
    #[serde(default)]
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SandboxSpec {
    pub image: String,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub ports: Vec<PortSpec>,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default = "default_memory")]
    pub memory_mb: u64,
    #[serde(default = "default_cpus")]
    pub cpus: f64,
    /// 不含凭据的运行包引用，供镜像 bootstrap 消费。
    #[serde(default)]
    pub bundle: Option<BundleRef>,
    /// 管理员白名单名称，不包含宿主路径或凭据。
    #[serde(default)]
    pub runtime_profile: Option<String>,
}
fn default_memory() -> u64 {
    256
}
fn default_cpus() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BundleRef {
    pub url: String,
    pub sha256: String,
    pub min_image_level: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Preparing,
    Running,
    Stopped,
    Deleting,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Resource {
    pub generation: u64,
    pub data_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Operation {
    Create,
    Start,
    Stop,
    Delete,
    Rebuild {
        previous: Resource,
        preserve_data: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sandbox {
    pub id: String,
    pub spec: SandboxSpec,
    pub resource: Resource,
    pub status: Status,
    pub operation: Option<Operation>,
    /// 重建尚未完成时保留旧代资源，删除可接续清理所有已知代际。
    #[serde(default)]
    pub retired: Vec<Resource>,
    pub revision: u64,
    pub endpoints: Vec<Endpoint>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub name: String,
    pub port: u16,
    pub visibility: Visibility,
    /// Gateway 可拨号地址，内部端点不会映射宿主。
    pub address: String,
}

#[derive(Debug, Clone)]
pub struct Observed {
    pub running: bool,
    pub endpoints: Vec<Endpoint>,
    /// 镜像/容器配置的健康状态，未配置 healthcheck 时为 None。
    pub healthy: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Capabilities {
    pub rebuild_preserve_data: bool,
    pub rebuild_destroy_data: bool,
}

pub fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

impl SandboxSpec {
    pub fn validate(&self) -> Result<()> {
        if self.image.is_empty()
            || self.image.starts_with('-')
            || self.image.chars().any(char::is_whitespace)
        {
            return Err(Error::Invalid("image 必须是有效镜像引用".into()));
        }
        if self.memory_mb < 16
            || self.memory_mb > 65536
            || !self.cpus.is_finite()
            || self.cpus <= 0.0
            || self.cpus > 128.0
        {
            return Err(Error::Invalid("资源限制超出允许范围".into()));
        }
        let mut names = std::collections::HashSet::new();
        let mut ports = std::collections::HashSet::new();
        for p in &self.ports {
            if !valid_name(&p.name)
                || p.port == 0
                || !names.insert(&p.name)
                || !ports.insert(p.port)
            {
                return Err(Error::Invalid("端点名称/端口非法或重复".into()));
            }
            if (p.name == "cdp" || p.name == "novnc" || p.port == 9222 || p.port == 6080)
                && p.visibility != Visibility::Internal
            {
                return Err(Error::Invalid("CDP/noVNC 必须为内部端点".into()));
            }
        }
        if self.labels.len() > 64
            || self.labels.iter().any(|(key, value)| {
                key.is_empty()
                    || key.len() > 128
                    || key.contains(['=', '\0'])
                    || value.len() > 4096
                    || value.contains('\0')
            })
        {
            return Err(Error::Invalid("用户标签非法或过大".into()));
        }
        if self.ports.len() > 32
            || self.command.len() > 128
            || self.command.iter().any(|v| v.contains('\0'))
        {
            return Err(Error::Invalid("规格过大或命令包含空字节".into()));
        }
        if let Some(profile) = &self.runtime_profile {
            if !valid_name(profile) || self.bundle.is_none() {
                return Err(Error::Invalid("运行配置需要有效名称和bundle引用".into()));
            }
        }
        if let Some(bundle) = &self.bundle {
            if !(bundle.url.starts_with("https://") || bundle.url.starts_with("http://"))
                || bundle.url.contains('@')
                || bundle.sha256.len() != 64
                || !bundle.sha256.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err(Error::Invalid(
                    "bundle 需要无凭据HTTP(S)地址和SHA256".into(),
                ));
            }
        }
        Ok(())
    }
}
