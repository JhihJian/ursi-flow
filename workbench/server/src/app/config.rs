use std::{env, ffi::OsString, io, net::SocketAddr, path::PathBuf};

pub(super) struct Config {
    pub listen: SocketAddr,
    pub token: String,
    pub flowd: OsString,
    pub flow_enabled: bool,
    pub home: PathBuf,
    pub workspace: PathBuf,
}

impl Config {
    pub fn from_env() -> io::Result<Self> {
        let invalid = |message| io::Error::new(io::ErrorKind::InvalidInput, message);
        let token = env::var("URSI_API_TOKEN").map_err(|_| invalid("请设置 URSI_API_TOKEN"))?;
        if token.is_empty() || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(invalid("URSI_API_TOKEN 必须为非空可见 ASCII 字符且无空格"));
        }
        let workspace =
            PathBuf::from(env::var_os("URSI_WORKSPACE_DIR").unwrap_or_else(|| ".".into()))
                .canonicalize()?;
        if !workspace.is_dir() {
            return Err(invalid("URSI_WORKSPACE_DIR 必须为目录"));
        }
        Ok(Self {
            listen: env::var("URSI_LISTEN_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:8080".into())
                .parse()
                .map_err(|_| invalid("无效的 URSI_LISTEN_ADDR"))?,
            home: PathBuf::from(env::var_os("URSI_DATA_DIR").unwrap_or_else(|| "data".into()))
                .join("flow-runtime"),
            flow_enabled: match env::var("URSI_FLOW_ENABLED").as_deref() {
                Ok("0") => false,
                Ok("1") | Err(env::VarError::NotPresent) => true,
                _ => return Err(invalid("URSI_FLOW_ENABLED 应为 0 或 1")),
            },
            flowd: env::var_os("URSI_FLOWD_BIN").unwrap_or_else(|| "ursi-flowd".into()),
            workspace,
            token,
        })
    }
}
