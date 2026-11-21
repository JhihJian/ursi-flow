//! 页面登记绑定平台变量。只有文件策略登记可使用宿主凭据。
use super::super::environment;
use super::{Binding, Config, Error, Store, invalid, unavailable};
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
        if !environment::valid_name(key) {
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
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(store.dir().join("mcp-policy.json"))
    {
        Ok(file) => file,
        Err(e) if cfg.binding == Binding::Platform && e.kind() == std::io::ErrorKind::NotFound => {
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
    if !grants
        .iter()
        .any(|g| g.url == cfg.url && g.credential_env == cfg.credential_env)
    {
        return Err(denied());
    }
    Ok(url)
}

pub(super) fn valid_bearer(value: &str) -> bool {
    !value.is_empty() && value.len() <= 8192 && value.bytes().all(|b| b.is_ascii_graphic())
}

pub(super) fn endpoint(store: &Store, cfg: &Config) -> Result<(Url, Option<HeaderValue>), Error> {
    let url = authorize(store, cfg)?;
    let auth = cfg
        .credential_env
        .as_ref()
        .map(|key| {
            let err = || unavailable("管理员配置的 MCP 凭据不可用");
            let value = match environment::lookup(store, key)? {
                Some(value) => value,
                None if cfg.binding == Binding::Policy => std::env::var(key).map_err(|_| err())?,
                None => {
                    return Err(unavailable(
                        "服务引用的平台变量已删除，请在环境变量页重新设置",
                    ));
                }
            };
            if !valid_bearer(&value) {
                return Err(err());
            }
            let mut h = HeaderValue::from_str(&format!("Bearer {value}")).map_err(|_| err())?;
            h.set_sensitive(true);
            Ok(h)
        })
        .transpose()?;
    Ok((url, auth))
}
