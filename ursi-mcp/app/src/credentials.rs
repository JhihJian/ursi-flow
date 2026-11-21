use crate::store::open_private;
use std::{
    collections::BTreeMap,
    fs::OpenOptions,
    io::{self, Read},
    path::PathBuf,
};
use ursi_mcp::{Binding, Credentials, Error};

const MAX_CREDENTIALS_SIZE: usize = 1024 * 1024;

pub struct DeploymentCredentials(pub PathBuf);

impl Credentials for DeploymentCredentials {
    fn lookup(&self, name: &str, _: Binding) -> Result<Option<String>, Error> {
        let unavailable = || Error::Unavailable("部署凭据文件不可用，请检查权限和格式".into());
        let file = match open_private(OpenOptions::new().read(true), &self.0) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(unavailable()),
        };
        let mut bytes = Vec::new();
        file.take((MAX_CREDENTIALS_SIZE + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| unavailable())?;
        if bytes.len() > MAX_CREDENTIALS_SIZE {
            return Err(unavailable());
        }
        let mut credentials: BTreeMap<String, String> =
            serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        Ok(credentials.remove(name))
    }
}
