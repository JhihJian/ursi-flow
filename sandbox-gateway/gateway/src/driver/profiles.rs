//! 管理员配置的运行目录白名单。请求只引用名称，不能构造宿主路径。
use crate::models::{Error, Result, valid_name};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Default)]
pub struct RuntimeProfiles {
    paths: BTreeMap<String, PathBuf>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Definition {
    config_dir: PathBuf,
}

impl RuntimeProfiles {
    pub fn load(file: &Path) -> Result<Self> {
        let data =
            std::fs::read(file).map_err(|_| Error::Invalid("运行配置白名单不可读取".into()))?;
        if data.len() > 65536 {
            return Err(Error::Invalid("运行配置白名单过大".into()));
        }
        let definitions: BTreeMap<String, Definition> = serde_json::from_slice(&data)
            .map_err(|_| Error::Invalid("运行配置白名单格式错误".into()))?;
        let mut paths = BTreeMap::new();
        for (name, definition) in definitions {
            if !valid_name(&name) || !definition.config_dir.is_absolute() {
                return Err(Error::Invalid("运行配置名称或绝对路径非法".into()));
            }
            check_directory(&definition.config_dir)?;
            let canonical = std::fs::canonicalize(&definition.config_dir)
                .map_err(|_| Error::Invalid("运行配置目录不可访问".into()))?;
            if canonical
                .to_str()
                .is_none_or(|s| s.contains([',', '\n', '\r']))
            {
                return Err(Error::Invalid("运行配置路径不能用于只读挂载".into()));
            }
            paths.insert(name, canonical);
        }
        Ok(Self { paths })
    }
    pub fn get(&self, name: &str) -> Result<&Path> {
        let path = self
            .paths
            .get(name)
            .ok_or_else(|| Error::Invalid("未知运行配置引用".into()))?;
        check_directory(path)?;
        Ok(path)
    }
    pub fn identity(&self) -> String {
        serde_json::to_string(&self.paths).expect("serializable profile paths")
    }
    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }
}

fn check_directory(path: &Path) -> Result<()> {
    let info =
        std::fs::symlink_metadata(path).map_err(|_| Error::Invalid("运行配置目录不存在".into()))?;
    if !info.is_dir() || info.file_type().is_symlink() {
        return Err(Error::Invalid("运行配置必须为普通目录".into()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if info.uid() != 0 || info.mode() & 0o077 != 0 {
            return Err(Error::Invalid("运行配置目录必须root所有且权限0700".into()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profiles_reject_unknown_names_invalid_schema_and_untrusted_directory() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("profiles.json");
        for input in [
            r#"{"pi":{"config_dir":"relative"}}"#,
            r#"{"../escape":{"config_dir":"/tmp"}}"#,
            r#"{"pi":{"config_dir":"/tmp","privileged":true}}"#,
        ] {
            std::fs::write(&file, input).unwrap();
            assert!(RuntimeProfiles::load(&file).is_err());
        }
        assert!(RuntimeProfiles::default().get("pi").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::write(
                &file,
                serde_json::json!({"pi":{"config_dir":dir.path()}}).to_string(),
            )
            .unwrap();
            assert!(RuntimeProfiles::load(&file).is_err());
        }
    }
}
