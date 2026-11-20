//! 登记不能授予出站权限。只有服务账户私有目录中的管理员策略能授权地址与凭据组合。
use super::{Config, Error, Store, invalid, unavailable};
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
}

pub(super) fn authorize(store: &Store, cfg: &Config) -> Result<Url, Error> {
    let denied = || invalid("MCP 地址与凭据引用未获管理员授权");
    let url = Url::parse(&cfg.url).map_err(|_| denied())?;
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
        return Err(denied());
    }
    if let Some(key) = cfg.credential_env.as_deref() {
        if key.is_empty()
            || key.len() > 128
            || !key.as_bytes()[0].is_ascii_uppercase()
            || !key
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
        {
            return Err(denied());
        }
        let local = url
            .host_str()
            .and_then(|s| s.trim_matches(['[', ']']).parse::<IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback());
        if url.scheme() != "https" && !local {
            return Err(denied());
        }
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(store.dir().join("mcp-policy.json"))
        .map_err(|_| denied())?;
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
    if !grants
        .iter()
        .any(|g| g.url == cfg.url && g.credential_env == cfg.credential_env)
    {
        return Err(denied());
    }
    Ok(url)
}

pub(super) fn endpoint(store: &Store, cfg: &Config) -> Result<(Url, Option<HeaderValue>), Error> {
    let url = authorize(store, cfg)?;
    let auth = cfg
        .credential_env
        .as_ref()
        .map(|key| {
            let err = || unavailable("管理员配置的 MCP 凭据不可用");
            let value = std::env::var(key).map_err(|_| err())?;
            if value.is_empty()
                || value.len() > 8192
                || !value.bytes().all(|b| b.is_ascii_graphic())
            {
                return Err(err());
            }
            let mut h = HeaderValue::from_str(&format!("Bearer {value}")).map_err(|_| err())?;
            h.set_sensitive(true);
            Ok(h)
        })
        .transpose()?;
    Ok((url, auth))
}
