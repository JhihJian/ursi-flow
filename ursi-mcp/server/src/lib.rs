//! Embeddable MCP registration, authorization and bounded Streamable HTTP operations.
mod client;
mod operations;
mod policy;
mod routes;
#[cfg(test)]
mod tests;

use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    sync::{Semaphore, SemaphorePermit},
    time::timeout,
};
use uuid::Uuid;

pub use operations::{Catalog, Input, Settings};
pub use policy::valid_credential_name;
const SNAPSHOT_LIMIT: usize = 4 * 1024 * 1024;
pub const MAX_SERVERS: usize = 128;

#[derive(Debug)]
pub enum Error {
    Invalid(String),
    NotFound(String),
    Unavailable(String),
    Internal(String),
}
fn invalid(s: &str) -> Error {
    Error::Invalid(s.into())
}
fn unavailable(s: &str) -> Error {
    Error::Unavailable(s.into())
}
fn missing() -> Error {
    Error::NotFound("MCP 服务不存在".into())
}
fn label(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}

#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Binding {
    #[default]
    Policy,
    Platform,
}
impl Binding {
    fn is_policy(&self) -> bool {
        *self == Self::Policy
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_env: Option<String>,
    #[serde(default, skip_serializing_if = "Binding::is_policy")]
    pub binding: Binding,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_settings"
    )]
    pub settings: Option<Settings>,
}
fn present_settings<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Settings>, D::Error> {
    Settings::deserialize(d).map(Some)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ServerRecord {
    pub id: String,
    #[serde(flatten)]
    pub config: Config,
}

/// The host owns persistence. Insert must enforce MAX_SERVERS atomically.
/// replace_settings updates only the named record's settings, never recreating a removed record.
pub trait ServerRepository: Send + Sync {
    fn list(&self) -> Result<Vec<ServerRecord>, Error>;
    fn get(&self, id: &str) -> Result<Option<ServerRecord>, Error>;
    fn insert(&self, row: &ServerRecord) -> Result<(), Error>;
    fn remove(&self, id: &str) -> Result<bool, Error>;
    fn replace_settings(&self, id: &str, settings: &Settings) -> Result<bool, Error>;
}
pub trait Credentials: Send + Sync {
    fn lookup(&self, name: &str, binding: Binding) -> Result<Option<String>, Error>;
}

/// Controls whether platform registrations require an explicit deployment grant.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PolicyMode {
    Optional,
    Required,
}

#[derive(Clone)]
pub struct McpPlatform(Arc<Inner>);
struct Inner {
    records: Arc<dyn ServerRepository>,
    credentials: Arc<dyn Credentials>,
    policy_file: PathBuf,
    policy_mode: PolicyMode,
    identity: rmcp::model::Implementation,
    slots: Semaphore,
}
impl McpPlatform {
    pub fn new(
        records: Arc<dyn ServerRepository>,
        credentials: Arc<dyn Credentials>,
        policy_file: PathBuf,
        client_name: &str,
        client_version: &str,
    ) -> Self {
        Self::with_policy_mode(
            records,
            credentials,
            policy_file,
            client_name,
            client_version,
            PolicyMode::Optional,
        )
    }

    pub fn with_policy_mode(
        records: Arc<dyn ServerRepository>,
        credentials: Arc<dyn Credentials>,
        policy_file: PathBuf,
        client_name: &str,
        client_version: &str,
        policy_mode: PolicyMode,
    ) -> Self {
        Self(Arc::new(Inner {
            records,
            credentials,
            policy_file,
            policy_mode,
            identity: rmcp::model::Implementation::new(client_name, client_version),
            slots: Semaphore::new(4),
        }))
    }
    /// Mount under the host's authenticated API prefix.
    pub fn routes(&self) -> axum::Router {
        routes::router(self.clone())
    }
    pub fn list(&self) -> Result<Vec<ServerRecord>, Error> {
        self.0.records.list()
    }
    fn lookup(&self, id: &str) -> Result<Config, Error> {
        self.0
            .records
            .get(id)?
            .map(|r| r.config)
            .ok_or_else(missing)
    }
    pub fn register(&self, mut config: Config) -> Result<ServerRecord, Error> {
        config.name = config.name.trim().into();
        if !label(&config.name, 240) {
            return Err(invalid("服务名称无效"));
        }
        let url = policy::authorize(self, &config)?;
        if let Some(s) = &config.settings {
            s.validate(&url)?;
            if s.empty() {
                config.settings = None;
            }
        }
        if (config.binding == Binding::Platform || self.0.policy_mode == PolicyMode::Required)
            && let Some(key) = &config.credential_env
        {
            let value = self
                .0
                .credentials
                .lookup(key, config.binding)?
                .ok_or_else(|| invalid("凭据引用不存在，请检查宿主凭据配置"))?;
            if !policy::valid_bearer(&value) {
                return Err(invalid("凭据不能用作 Bearer 令牌，请检查空格或换行"));
            }
        }
        let row = ServerRecord {
            id: Uuid::new_v4().to_string(),
            config,
        };
        self.0.records.insert(&row)?;
        Ok(row)
    }
    pub fn remove(&self, id: &str) -> Result<(), Error> {
        self.0.records.remove(id)?.then_some(()).ok_or_else(missing)
    }
    pub fn replace_settings(&self, id: &str, s: Settings) -> Result<Settings, Error> {
        s.validate(&policy::authorize(self, &self.lookup(id)?)?)?;
        self.0
            .records
            .replace_settings(id, &s)?
            .then_some(s)
            .ok_or_else(missing)
    }
    pub fn operation(&self) -> Result<Operation<'_>, Error> {
        Ok(Operation {
            platform: self,
            _permit: self
                .0
                .slots
                .try_acquire()
                .map_err(|_| unavailable("MCP 请求过多，请稍后重试"))?,
        })
    }
    pub async fn inspect(&self, id: &str) -> Result<Value, Error> {
        self.discover(id, true).await
    }
    pub async fn list_resources(&self, id: &str) -> Result<Value, Error> {
        self.discover(id, false).await
    }
    async fn discover(&self, id: &str, inspection: bool) -> Result<Value, Error> {
        let cfg = self.lookup(id)?;
        let _op = self.operation()?;
        timeout(Duration::from_secs(25), async {
            let conn = client::Session::open(self, &cfg).await?;
            let result = async {
                if !inspection {
                    return conn.list().await.map(Value::Array);
                }
                let server = conn.info()?;
                let resources = if conn.has_resources() {
                    conn.list().await?
                } else {
                    vec![]
                };
                Ok(json!({"server":server,"resources":resources}))
            }
            .await;
            conn.close().await;
            result
        })
        .await
        .map_err(|_| unavailable("MCP 资源发现超时"))?
    }
    pub async fn preview(&self, id: &str, uri: &str) -> Result<Value, Error> {
        validate_uri(uri)?;
        let mut op = self.operation()?;
        timeout(Duration::from_secs(25), op.read(id, uri, |_, err| err))
            .await
            .map_err(|_| unavailable("MCP 资源读取超时"))?
    }
}
fn validate_uri(uri: &str) -> Result<(), Error> {
    label(uri, 4096)
        .then_some(())
        .ok_or_else(|| invalid("资源 URI 无效"))
}
/// A multi-resource operation holds one slot until dropped. Reads are sequential, each with fresh authorization and a new session.
pub struct Operation<'a> {
    platform: &'a McpPlatform,
    _permit: SemaphorePermit<'a>,
}
impl Operation<'_> {
    /// Returns the `contents` array. The host owns the enclosing operation deadline.
    pub async fn read_resource(&mut self, id: &str, uri: &str) -> Result<Value, Error> {
        validate_uri(uri)?;
        self.read(id, uri, |cfg, _| {
            unavailable(&format!("读取 MCP 资源失败：{}，{}", cfg.name, uri))
        })
        .await
    }
    async fn read(
        &mut self,
        id: &str,
        uri: &str,
        map: impl FnOnce(&Config, Error) -> Error,
    ) -> Result<Value, Error> {
        let cfg = self.platform.lookup(id)?;
        let conn = client::Session::open(self.platform, &cfg).await?;
        let result = conn.read(uri).await;
        conn.close().await;
        result.map_err(|err| map(&cfg, err))
    }
}
