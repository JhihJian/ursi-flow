//! 端点授权和出站认证。凭据值由宿主提供。
use super::{Binding, Config, Error, McpPlatform, PolicyMode, invalid, unavailable};
use reqwest::{Url, header::HeaderValue};
use serde::Deserialize;
use std::{
    fs::OpenOptions,
    io::Read,
    net::IpAddr,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Grant {
    url: String,
    credential_env: Option<String>,
    /// Deployment opts in per endpoint before users may attach inline secrets.
    #[serde(default)]
    allow_secret: bool,
    #[serde(default)]
    allowed_tools: Vec<String>,
}

pub(super) fn authorize(store: &McpPlatform, cfg: &Config) -> Result<Url, Error> {
    authorize_operation(store, cfg, None)
}

pub(super) fn authorize_operation(
    store: &McpPlatform,
    cfg: &Config,
    tool: Option<&str>,
) -> Result<Url, Error> {
    let denied = || invalid("MCP 地址与凭据引用未获管理员授权");
    let bad_url = || invalid("请输入完整 HTTP(S) 端点，不含用户名、密码、查询参数或片段");
    let url = Url::parse(&cfg.url).map_err(|_| bad_url())?;
    if cfg.url.len() > 2048
        || !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || cfg
            .url
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return Err(bad_url());
    }
    if let Some(key) = cfg.credential_env.as_deref() {
        if !valid_credential_name(key) {
            return Err(invalid("凭据变量名无效"));
        }
        let local = url
            .host_str()
            .and_then(|s| s.trim_matches(['[', ']']).parse::<IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback());
        if url.scheme() != "https" && !local {
            return Err(invalid("携带凭据的服务地址须使用 HTTPS，回环 IP 除外"));
        }
    }
    if cfg.credential_secret.is_some() {
        if cfg.credential_env.is_some() {
            return Err(invalid("凭据引用与直接填写密钥只能选择其一"));
        }
        let local = url
            .host_str()
            .and_then(|s| s.trim_matches(['[', ']']).parse::<IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback());
        if url.scheme() != "https" && !local {
            return Err(invalid("携带密钥的服务地址须使用 HTTPS，回环 IP 除外"));
        }
    }
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&store.0.policy_file)
    {
        Ok(file) => file,
        Err(e)
            if store.0.policy_mode == PolicyMode::Optional
                && cfg.binding == Binding::Platform
                && e.kind() == std::io::ErrorKind::NotFound =>
        {
            return Ok(url);
        }
        Err(_) => return Err(denied()),
    };
    let meta = file.metadata().map_err(|_| denied())?;
    if !meta.is_file() || meta.permissions().mode() & 0o022 != 0 {
        return Err(denied());
    }
    let mut bytes = Vec::new();
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| denied())?;
    if bytes.len() > 65536 {
        return Err(denied());
    }
    let grants: Vec<Grant> = serde_json::from_slice(&bytes).map_err(|_| denied())?;
    if !grants.iter().any(|g| {
        g.url == cfg.url
            && g.credential_env == cfg.credential_env
            && (cfg.credential_secret.is_none() || g.allow_secret)
            && tool.is_none_or(|name| g.allowed_tools.iter().any(|s| s == name))
    }) {
        return Err(denied());
    }
    Ok(url)
}

pub(super) fn valid_bearer(value: &str) -> bool {
    !value.is_empty() && value.len() <= 8192 && value.bytes().all(|b| b.is_ascii_graphic())
}

pub(super) fn endpoint(
    store: &McpPlatform,
    cfg: &Config,
) -> Result<(Url, Option<HeaderValue>), Error> {
    let url = authorize(store, cfg)?;
    let auth = if let Some(value) = cfg.credential_secret.as_deref() {
        if !valid_bearer(value) {
            return Err(unavailable("登记的密钥不能用作 Bearer 令牌，请检查空格或换行"));
        }
        let mut h = HeaderValue::from_str(&format!("Bearer {value}"))
            .map_err(|_| unavailable("登记的密钥不能用作 Bearer 令牌，请检查空格或换行"))?;
        h.set_sensitive(true);
        Some(h)
    } else if let Some(key) = cfg.credential_env.as_deref() {
        let err = || unavailable("服务引用的 MCP 凭据不可用，请检查宿主凭据配置");
        let value = store
            .0
            .credentials
            .lookup(key, cfg.binding)?
            .ok_or_else(&err)?;
        if !valid_bearer(&value) {
            return Err(err());
        }
        let mut h = HeaderValue::from_str(&format!("Bearer {value}")).map_err(|_| err())?;
        h.set_sensitive(true);
        Some(h)
    } else {
        None
    };
    Ok((url, auth))
}

pub fn valid_credential_name(name: &str) -> bool {
    name.len() <= 128
        && name.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
        && name
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}
