use crate::models::BundleRef;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::Path,
};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RegistryError {
    #[error("注册表 JSON 无效: {0}")]
    Json(String),
    #[error("注册表文件读取失败: {0}")]
    Io(String),
    #[error("注册表配置无效: {0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, RegistryError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BundleEndpoint {
    pub name: String,
    pub protocol: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BundleDefinition {
    /// 配置映射的 key 是推荐的 ID。JSON 中省略 id 时由 Registry 从 key 补齐。
    #[serde(default)]
    pub id: String,
    #[serde(default = "default_version")]
    pub version: String,
    pub endpoints: Vec<BundleEndpoint>,
    /// 管理员批准的不可变 Runtime 包。创建请求不能覆盖该来源。
    #[serde(default)]
    pub runtime: Option<BundleRef>,
    #[serde(default)]
    pub requires: Vec<String>,
    #[serde(default)]
    pub conflicts: Vec<String>,
    #[serde(default)]
    pub services: Vec<String>,
    #[serde(default)]
    pub readiness: BTreeMap<String, String>,
}

/// 一个镜像注册的 bundle ID 列表。JSON 表示为字符串数组。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(transparent, deny_unknown_fields)]
pub struct ImageRegistration(pub Vec<String>);

impl ImageRegistration {
    pub fn new(bundles: Vec<String>) -> Self {
        Self(bundles)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn bundles(&self) -> &[String] {
        &self.0
    }
}

impl AsRef<[String]> for ImageRegistration {
    fn as_ref(&self) -> &[String] {
        &self.0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct RegistryConfig {
    #[serde(default)]
    pub bundles: BTreeMap<String, BundleDefinition>,
    #[serde(default)]
    pub images: BTreeMap<String, ImageRegistration>,
}

/// 展开后保留来源 bundle，便于构造公共逻辑 Endpoint。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RegisteredEndpoint {
    pub name: String,
    pub bundle: String,
    pub protocol: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Registry {
    pub bundles: BTreeMap<String, BundleDefinition>,
    pub images: BTreeMap<String, ImageRegistration>,
}

impl RegistryConfig {
    pub fn from_json(input: &str) -> Result<Self> {
        serde_json::from_str(input).map_err(|error| RegistryError::Json(error.to_string()))
    }

    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let input =
            fs::read_to_string(path).map_err(|error| RegistryError::Io(error.to_string()))?;
        Self::from_json(&input)
    }

    fn into_registry(self) -> Result<Registry> {
        Registry::from_config(self)
    }

    pub fn validate(self) -> Result<Registry> {
        self.into_registry()
    }
}

impl Registry {
    pub fn new(config: RegistryConfig) -> Result<Self> {
        Self::from_config(config)
    }

    pub fn from_config(mut config: RegistryConfig) -> Result<Self> {
        for (key, definition) in &mut config.bundles {
            if definition.id.is_empty() {
                definition.id = key.clone();
            } else if definition.id != *key {
                return Err(RegistryError::Invalid(format!(
                    "bundle ID {} 与配置 key {} 不一致",
                    definition.id, key
                )));
            }
        }
        let registry = Self {
            bundles: config.bundles,
            images: config.images,
        };
        registry.validate()?;
        Ok(registry)
    }

    pub fn from_json(input: &str) -> Result<Self> {
        RegistryConfig::from_json(input)?.validate()
    }

    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        RegistryConfig::load(path)?.validate()
    }

    pub fn validate(&self) -> Result<()> {
        for (key, bundle) in &self.bundles {
            if key != &bundle.id || !valid_id(key) || bundle.version.trim().is_empty() {
                return Err(RegistryError::Invalid(format!(
                    "bundle ID 或版本非法: {}",
                    key
                )));
            }
            if let Some(runtime) = &bundle.runtime {
                validate_runtime(key, runtime)?;
            }
            if bundle.services.iter().any(|service| !valid_id(service)) {
                return Err(RegistryError::Invalid(format!(
                    "bundle {} 的 service 非法",
                    key
                )));
            }
            for endpoint in bundle.readiness.keys() {
                if !bundle.endpoints.iter().any(|item| item.name == *endpoint) {
                    return Err(RegistryError::Invalid(format!(
                        "bundle {} 的 readiness 未声明端点: {}",
                        key, endpoint
                    )));
                }
            }
            validate_endpoints(key, &bundle.endpoints)?;
            let mut requires = HashSet::new();
            for required in &bundle.requires {
                if !valid_id(required) || !requires.insert(required) {
                    return Err(RegistryError::Invalid(format!(
                        "bundle {} 的依赖非法或重复: {}",
                        key, required
                    )));
                }
                if !self.bundles.contains_key(required) {
                    return Err(RegistryError::Invalid(format!(
                        "bundle {} 依赖缺失: {}",
                        key, required
                    )));
                }
            }
            let mut conflicts = HashSet::new();
            for conflict in &bundle.conflicts {
                if !valid_id(conflict)
                    || conflict == key
                    || !conflicts.insert(conflict)
                    || !self.bundles.contains_key(conflict)
                {
                    return Err(RegistryError::Invalid(format!(
                        "bundle {} 的冲突声明非法: {}",
                        key, conflict
                    )));
                }
            }
        }
        for (image, registration) in &self.images {
            if !valid_image(image) {
                return Err(RegistryError::Invalid(format!("镜像引用非法: {}", image)));
            }
            let mut bundles = HashSet::new();
            for bundle in &registration.0 {
                if !bundles.insert(bundle) {
                    return Err(RegistryError::Invalid(format!(
                        "镜像 {} 重复注册 bundle: {}",
                        image, bundle
                    )));
                }
                if !self.bundles.contains_key(bundle) {
                    return Err(RegistryError::Invalid(format!(
                        "镜像 {} 引用缺失 bundle: {}",
                        image, bundle
                    )));
                }
            }
        }
        for bundle in self.bundles.keys() {
            let mut visiting = HashSet::new();
            let mut visited = HashSet::new();
            self.visit(bundle, &mut visiting, &mut visited)?;
        }
        Ok(())
    }

    fn visit(
        &self,
        id: &str,
        visiting: &mut HashSet<String>,
        visited: &mut HashSet<String>,
    ) -> Result<()> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.to_owned()) {
            return Err(RegistryError::Invalid(format!("bundle 依赖循环: {}", id)));
        }
        let bundle = self
            .bundles
            .get(id)
            .ok_or_else(|| RegistryError::Invalid(format!("bundle 依赖缺失: {}", id)))?;
        for required in &bundle.requires {
            self.visit(required, visiting, visited)?;
        }
        visiting.remove(id);
        visited.insert(id.to_owned());
        Ok(())
    }

    /// 未注册镜像返回空注册，不把镜像自身视为可信能力来源。
    pub fn lookup_image(&self, image: &str) -> ImageRegistration {
        self.images.get(image).cloned().unwrap_or_default()
    }

    pub fn registered_bundles(&self, image: &str) -> Vec<String> {
        self.lookup_image(image).0
    }

    /// 返回镜像组合后的唯一管理员批准 Runtime 包。
    pub fn runtime_for_image(&self, image: &str) -> Result<Option<BundleRef>> {
        let bundles = self.lookup_image(image).0;
        let mut expanded = Vec::new();
        for id in bundles {
            self.collect_runtime_bundles(&id, &mut expanded)?;
        }
        let mut selected = None;
        for id in expanded {
            let bundle = self
                .bundles
                .get(&id)
                .ok_or_else(|| RegistryError::Invalid(format!("bundle 依赖缺失: {id}")))?;
            if let Some(runtime) = &bundle.runtime {
                if selected
                    .as_ref()
                    .is_some_and(|current: &BundleRef| current != runtime)
                {
                    return Err(RegistryError::Invalid(format!(
                        "镜像 {} 的 bundle 使用了冲突 Runtime 包",
                        image
                    )));
                }
                selected = Some(runtime.clone());
            }
        }
        Ok(selected)
    }

    fn collect_runtime_bundles(&self, id: &str, output: &mut Vec<String>) -> Result<()> {
        let bundle = self
            .bundles
            .get(id)
            .ok_or_else(|| RegistryError::Invalid(format!("bundle 依赖缺失: {id}")))?;
        for required in &bundle.requires {
            self.collect_runtime_bundles(required, output)?;
        }
        if !output.iter().any(|item| item == id) {
            output.push(id.to_owned());
        }
        Ok(())
    }

    /// 展开镜像的所有注册 bundle，依赖先于直接注册项，端点按 name/protocol/port 去重。
    pub fn expand_image(&self, image: &str) -> Result<Vec<BundleEndpoint>> {
        Ok(self
            .expand_image_with_bundles(image)?
            .into_iter()
            .map(|endpoint| BundleEndpoint {
                name: endpoint.name,
                protocol: endpoint.protocol,
                port: endpoint.port,
            })
            .collect())
    }

    pub fn endpoints_for_image(&self, image: &str) -> Result<Vec<BundleEndpoint>> {
        self.expand_image(image)
    }

    pub fn expand_image_with_bundles(&self, image: &str) -> Result<Vec<RegisteredEndpoint>> {
        let registration = self.lookup_image(image);
        self.expand_bundles(&registration.0)
    }

    pub fn expand_bundles(&self, bundle_ids: &[String]) -> Result<Vec<RegisteredEndpoint>> {
        let mut ordered = Vec::new();
        let mut expanded = HashSet::new();
        let mut selected = HashSet::new();
        for id in bundle_ids {
            self.collect_bundle(id, &mut selected)?;
        }
        for id in &selected {
            let bundle = self
                .bundles
                .get(id)
                .ok_or_else(|| RegistryError::Invalid(format!("bundle 依赖缺失: {}", id)))?;
            for conflict in &bundle.conflicts {
                if selected.contains(conflict) {
                    return Err(RegistryError::Invalid(format!(
                        "bundle {} 与 {} 冲突",
                        id, conflict
                    )));
                }
            }
        }
        for id in bundle_ids {
            self.expand_bundle(id, &mut expanded, &mut ordered)?;
        }
        Ok(ordered)
    }

    fn collect_bundle(&self, id: &str, selected: &mut HashSet<String>) -> Result<()> {
        if !selected.insert(id.to_owned()) {
            return Ok(());
        }
        let bundle = self
            .bundles
            .get(id)
            .ok_or_else(|| RegistryError::Invalid(format!("bundle 依赖缺失: {}", id)))?;
        for required in &bundle.requires {
            self.collect_bundle(required, selected)?;
        }
        Ok(())
    }

    fn expand_bundle(
        &self,
        id: &str,
        expanded: &mut HashSet<String>,
        endpoints: &mut Vec<RegisteredEndpoint>,
    ) -> Result<()> {
        if !expanded.insert(id.to_owned()) {
            return Ok(());
        }
        let bundle = self
            .bundles
            .get(id)
            .ok_or_else(|| RegistryError::Invalid(format!("bundle 依赖缺失: {}", id)))?;
        for required in &bundle.requires {
            self.expand_bundle(required, expanded, endpoints)?;
        }
        for endpoint in &bundle.endpoints {
            if endpoints
                .iter()
                .any(|existing| existing.name == endpoint.name || existing.port == endpoint.port)
            {
                return Err(RegistryError::Invalid(format!(
                    "bundle {} 组合后端点名称或端口重复: {}:{}",
                    id, endpoint.name, endpoint.port
                )));
            }
            endpoints.push(RegisteredEndpoint {
                name: endpoint.name.clone(),
                bundle: id.to_owned(),
                protocol: endpoint.protocol.clone(),
                port: endpoint.port,
            });
        }
        Ok(())
    }
}

fn validate_endpoints(bundle: &str, endpoints: &[BundleEndpoint]) -> Result<()> {
    let mut names = HashSet::new();
    let mut ports = HashSet::new();
    for endpoint in endpoints {
        if !valid_id(&endpoint.name)
            || !valid_protocol(&endpoint.protocol)
            || endpoint.port == 0
            || !names.insert(&endpoint.name)
            || !ports.insert(endpoint.port)
        {
            return Err(RegistryError::Invalid(format!(
                "bundle {} 的端点名称、协议、端口非法或重复",
                bundle
            )));
        }
    }
    Ok(())
}

fn validate_runtime(bundle: &str, runtime: &BundleRef) -> Result<()> {
    if !(runtime.url.starts_with("https://") || runtime.url.starts_with("http://"))
        || runtime.url.contains('@')
        || runtime.sha256.len() != 64
        || !runtime.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || runtime.min_image_level == 0
    {
        return Err(RegistryError::Invalid(format!(
            "bundle {} 的 runtime 来源非法",
            bundle
        )));
    }
    Ok(())
}

fn default_version() -> String {
    "1".into()
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn valid_protocol(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(byte) if byte.is_ascii_alphabetic())
        && value.len() <= 32
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

fn valid_image(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_json() -> &'static str {
        r#"{
          "bundles": {
            "base": {"endpoints": [{"name":"agent","protocol":"tcp","port":9000}]},
            "ssh": {"endpoints": [{"name":"ssh","protocol":"ssh","port":2222}], "requires":["base"]}
          },
          "images": {"image:tag": ["ssh"]}
        }"#
    }

    #[test]
    fn loads_and_expands_full_config() {
        let registry = Registry::from_json(valid_json()).unwrap();
        assert_eq!(registry.lookup_image("image:tag").bundles(), &["ssh"]);
        let endpoints = registry.expand_image_with_bundles("image:tag").unwrap();
        assert_eq!(endpoints[0].bundle, "base");
        assert_eq!(endpoints[1].name, "ssh");
    }

    #[test]
    fn unknown_image_has_no_registration() {
        let registry = Registry::from_json(valid_json()).unwrap();
        assert!(registry.lookup_image("other:tag").is_empty());
        assert!(registry.expand_image("other:tag").unwrap().is_empty());
    }

    #[test]
    fn rejects_duplicate_endpoint() {
        let input = r#"{"bundles":{"ssh":{"endpoints":[{"name":"ssh","protocol":"ssh","port":2222},{"name":"ssh","protocol":"ssh","port":2223}]}},"images":{}}"#;
        assert!(Registry::from_json(input).is_err());
    }

    #[test]
    fn rejects_missing_dependency_and_cycle() {
        let missing = r#"{"bundles":{"ssh":{"endpoints":[],"requires":["base"]}},"images":{}}"#;
        assert!(Registry::from_json(missing).is_err());
        let cycle = r#"{"bundles":{"a":{"endpoints":[],"requires":["b"]},"b":{"endpoints":[],"requires":["a"]}},"images":{}}"#;
        assert!(Registry::from_json(cycle).is_err());
    }

    #[test]
    fn rejects_duplicate_endpoints_after_composition() {
        let input = r#"{"bundles":{"base":{"endpoints":[{"name":"agent","protocol":"tcp","port":9000}]},"derived":{"endpoints":[{"name":"agent","protocol":"tcp","port":9000}],"requires":["base"]}},"images":{"image:tag":["derived"]}}"#;
        let registry = Registry::from_json(input).unwrap();
        assert!(registry.expand_image("image:tag").is_err());
    }

    #[test]
    fn rejects_conflicting_composition() {
        let input = r#"{"bundles":{"ssh":{"endpoints":[],"conflicts":["browser"]},"browser":{"endpoints":[]}},"images":{"image:tag":["ssh","browser"]}}"#;
        let registry = Registry::from_json(input).unwrap();
        assert!(registry.expand_image("image:tag").is_err());
    }

    #[test]
    fn runtime_source_is_admin_bound_and_inherited_by_image() {
        let input = r#"{
          "bundles": {
            "base": {
              "runtime": {"url":"https://example.invalid/base.tgz","sha256":"0000000000000000000000000000000000000000000000000000000000000000","min_image_level":1},
              "endpoints": []
            },
            "browser": {"requires":["base"],"endpoints":[]}
          },
          "images": {"image:tag":["browser"]}
        }"#;
        let registry = Registry::from_json(input).unwrap();
        assert_eq!(
            registry
                .runtime_for_image("image:tag")
                .unwrap()
                .unwrap()
                .min_image_level,
            1
        );
    }

    #[test]
    fn rejects_untrusted_runtime_source() {
        let input = r#"{"bundles":{"ssh":{"runtime":{"url":"file:///tmp/bundle","sha256":"bad","min_image_level":1},"endpoints":[]}},"images":{}}"#;
        assert!(Registry::from_json(input).is_err());
    }

    #[test]
    fn rejects_duplicate_bundle_registration_for_image() {
        let input = r#"{"bundles":{"ssh":{"endpoints":[]}},"images":{"image:tag":["ssh","ssh"]}}"#;
        assert!(Registry::from_json(input).is_err());
    }
}
