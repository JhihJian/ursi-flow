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
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{RwLock, Semaphore, SemaphorePermit},
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
    /// Direct bearer value; mutually exclusive with `credential_env`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Binding::is_policy")]
    pub binding: Binding,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_settings"
    )]
    pub settings: Option<Settings>,
}
impl Config {
    pub fn carries_credential(&self) -> bool {
        self.credential_env.is_some() || self.credential_secret.is_some()
    }
}
fn present_settings<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Settings>, D::Error> {
    Settings::deserialize(d).map(Some)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRecord {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "stored_check")]
    pub protocol_check: Option<ProtocolCheck>,
    #[serde(flatten)]
    pub config: Config,
}
impl ServerRecord {
    /// API views never carry the secret value, only whether one is stored.
    pub fn redacted(&self) -> Value {
        let mut value = serde_json::to_value(self).expect("record serializes");
        if value["credentialSecret"].is_string() {
            value["credentialSecret"] = json!(true);
        }
        value
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecognitionRule {
    pub id: String,
    pub label: String,
    pub meta_key: String,
    pub equals: String,
}

pub fn default_recognition_rules() -> Vec<RecognitionRule> {
    vec![RecognitionRule {
        id: "executor-v1".into(),
        label: "执行器 v1".into(),
        meta_key: "ursi/executorProtocol".into(),
        equals: "1".into(),
    }]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProtocolStatus {
    Checked,
    Legacy,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolCheck {
    pub status: ProtocolStatus,
    pub checked_at: u64,
    pub labels: Vec<String>,
}

fn stored_check<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<ProtocolCheck>, D::Error> {
    let Some(value) = Option::<Value>::deserialize(d)? else { return Ok(None) };
    // Pre-rule checks had no labels and cannot be evaluated without a fresh discovery.
    if value.get("labels").is_none() && value["checkedAt"].is_u64() && matches!(
        value["status"].as_str(),
        Some("declaredV1" | "notDeclared" | "unsupportedVersion" | "invalidDeclaration" | "legacy")
    ) {
        return Ok(None);
    }
    serde_json::from_value(value).map(Some).map_err(serde::de::Error::custom)
}

/// The host owns persistence. Insert must enforce MAX_SERVERS atomically.
/// Updates touch only the named field, never recreating a removed record.
pub trait ServerRepository: Send + Sync {
    /// Seed an uninitialized store with `default_recognition_rules`, never a saved empty list.
    fn recognition_rules(&self) -> Result<Vec<RecognitionRule>, Error>;
    /// Atomically save the ordered rules and clear every stored protocol check.
    fn replace_recognition_rules(&self, rules: &[RecognitionRule]) -> Result<(), Error>;
    fn list(&self) -> Result<Vec<ServerRecord>, Error>;
    fn get(&self, id: &str) -> Result<Option<ServerRecord>, Error>;
    fn insert(&self, row: &ServerRecord) -> Result<(), Error>;
    fn remove(&self, id: &str) -> Result<bool, Error>;
    fn replace_settings(&self, id: &str, settings: &Settings) -> Result<bool, Error>;
    fn record_protocol_check(&self, id: &str, check: &ProtocolCheck) -> Result<bool, Error>;
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
    recognition_lock: RwLock<()>,
    active_checks: Mutex<HashSet<String>>,
}

struct ActiveProtocolCheck<'a> {
    active: &'a Mutex<HashSet<String>>,
    id: &'a str,
}
impl Drop for ActiveProtocolCheck<'_> {
    fn drop(&mut self) {
        self.active.lock().unwrap().remove(self.id);
    }
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
            recognition_lock: RwLock::new(()),
            active_checks: Mutex::new(HashSet::new()),
        }))
    }
    /// Mount under the host's authenticated API prefix.
    pub fn routes(&self) -> axum::Router {
        routes::router(self.clone())
    }
    pub fn recognition_rules(&self) -> Result<Vec<RecognitionRule>, Error> {
        self.0.records.recognition_rules()
    }
    pub async fn replace_recognition_rules(&self, rules: Vec<RecognitionRule>) -> Result<Vec<RecognitionRule>, Error> {
        let _guard = self.0.recognition_lock.write().await;
        self.0.records.replace_recognition_rules(&rules)?;
        Ok(rules)
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
        // Registration follows outbound access: a present policy file enforces the
        // allowlist immediately, while transport and credential-shape checks always apply.
        policy::validate(&config)?;
        if self.0.policy_file.exists() {
            policy::authorize(self, &config)?;
        } else if self.0.policy_mode == PolicyMode::Required {
            return Err(invalid("MCP 地址与凭据引用未获管理员授权"));
        }
        if let Some(s) = &config.settings {
            let url = reqwest::Url::parse(&config.url).map_err(|_| invalid("服务地址无效"))?;
            s.validate(&url)?;
            if s.empty() {
                config.settings = None;
            }
        }        if let Some(value) = config.credential_secret.as_deref() {
            if !policy::valid_bearer(value) {
                return Err(invalid("密钥不能用作 Bearer 令牌，请检查空格或换行"));
            }
        }
        if self.0.policy_mode == PolicyMode::Required
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
            protocol_check: None,
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
    pub async fn check_protocol(&self, id: &str) -> Result<ProtocolCheck, Error> {
        let cfg = self.lookup(id)?;
        let _op = self.operation()?;
        let active = &self.0.active_checks;
        if !active.lock().unwrap().insert(id.to_owned()) {
            return Err(unavailable("该 MCP 服务正在检查协议，请稍后重试"));
        }
        let _check = ActiveProtocolCheck { active, id };
        // Keep the rule snapshot valid through record_protocol_check, including across clones.
        let _guard = self.0.recognition_lock.read().await;
        let rules = self.recognition_rules()?;
        let (status, labels) = timeout(Duration::from_secs(25), async {
            let conn = client::Session::open(self, &cfg).await?;
            let result = conn.recognize(&rules);
            conn.close().await;
            result
        })
        .await
        .map_err(|_| unavailable("MCP 协议检查超时"))??;
        let check = ProtocolCheck {
            status,
            labels,
            checked_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| Error::Internal("系统时间无效".into()))?
                .as_millis() as u64,
        };
        self.0
            .records
            .record_protocol_check(id, &check)?
            .then_some(check)
            .ok_or_else(missing)
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
