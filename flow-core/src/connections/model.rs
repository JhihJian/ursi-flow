//! 连接域模型：`ModelConnection`、服务类型、校验错误与交付 DTO。
//!
//! 校验规则：
//! - `name`、`service_type`、`endpoint`、`credential_ref` 必填；
//! - endpoint 必须是 http(s) 绝对地址，拒绝携带 userinfo（`user:pass@`）的地址，
//!   校验错误不回显字段值（含 userinfo 的地址只报告"检测到认证信息"）。

use serde::{Deserialize, Serialize};

/// 模型服务类型。
///
/// 取值是稳定字符串，便于跨进程契约与存储序列化：
/// - `OpenAiCompatible`：OpenAI 兼容 Chat Completions 协议；
/// - `Anthropic`：Anthropic Messages 协议；
/// - `Other(T)` 保留未识别的注册值，保证前向兼容（读回旧数据不丢字段语义）。
///
/// 序列化形态为小写下划线字符串（如 `openai_compatible`）。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceType {
    /// OpenAI 兼容协议（Chat Completions 及其兼容网关）。
    /// 显式指定契约字符串，避免 rename_all 把它变成 open_ai_compatible。
    #[serde(rename = "openai_compatible")]
    OpenAiCompatible,
    /// Anthropic Messages 协议。
    Anthropic,
    /// 其他已注册但本版本未定义语义的类型，原样保留。
    #[serde(untagged)]
    Other(String),
}

impl ServiceType {
    /// 解析服务类型字符串，未注册的值保留为 `Other`。
    pub fn parse(raw: &str) -> Self {
        match raw {
            "openai_compatible" => Self::OpenAiCompatible,
            "anthropic" => Self::Anthropic,
            other => Self::Other(other.to_string()),
        }
    }

    /// 存储与契约使用的稳定字符串。
    pub fn as_str(&self) -> &str {
        match self {
            Self::OpenAiCompatible => "openai_compatible",
            Self::Anthropic => "anthropic",
            Self::Other(s) => s.as_str(),
        }
    }
}

impl std::fmt::Display for ServiceType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 模型服务连接。业务存储与对外交付只含凭据引用，不含凭据明文。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelConnection {
    /// 稳定连接标识。
    pub id: String,
    /// 连接名称，必填。
    pub name: String,
    /// 模型服务类型。
    pub service_type: ServiceType,
    /// 服务地址，http(s) URL，禁止 userinfo。
    pub endpoint: String,
    /// 凭据引用（不是密钥本身），必填。
    pub credential_ref: String,
    /// 创建时间（RFC 3339，存储层生成）。
    #[serde(default)]
    pub created_at: Option<String>,
}

/// 字段级校验错误。原因文本脱敏，不回显字段值。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConnectionValidationError {
    /// 必填字段缺失或为空白。
    #[error("字段 {0} 必填")]
    Required(&'static str),
    /// endpoint 不是合法的 http(s) URL。
    #[error("字段 endpoint 必须是合法的 http(s) URL")]
    InvalidEndpoint,
    /// endpoint 携带 userinfo（user:pass@），拒绝保存。
    #[error("字段 endpoint 携带内嵌认证信息，已拒绝（不回显其内容）")]
    EmbeddedCredential,
}

/// 校验并返回规范化后的 endpoint（保留原始大小写，仅做 URL 合法性判断）。
pub(crate) fn validate_connection(
    name: &str,
    service_type: &ServiceType,
    endpoint: &str,
    credential_ref: &str,
) -> Result<String, ConnectionValidationError> {
    if name.trim().is_empty() {
        return Err(ConnectionValidationError::Required("name"));
    }
    if service_type.as_str().trim().is_empty() {
        return Err(ConnectionValidationError::Required("service_type"));
    }
    if credential_ref.trim().is_empty() {
        return Err(ConnectionValidationError::Required("credential_ref"));
    }
    validate_endpoint(endpoint)
}

/// 校验 endpoint：必须是 http/https 绝对地址，且不得携带 userinfo。
///
/// 本模块不引入完整 URL 解析依赖，只做交付契约要求的结构校验：
/// scheme 必须是 http/https，authority 必须非空且不含 userinfo。
/// userinfo 判定依据 RFC 3986：authority 中首个 '@' 之前的部分属于用户信息，
/// 含 '@' 的 authority 一律拒绝（即使形如含百分号编码的合法用户名）。
fn validate_endpoint(endpoint: &str) -> Result<String, ConnectionValidationError> {
    let trimmed = endpoint.trim();
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return Err(ConnectionValidationError::InvalidEndpoint);
    };
    if !matches!(scheme, "http" | "https") || scheme.is_empty() {
        return Err(ConnectionValidationError::InvalidEndpoint);
    }
    // authority 到 path/query/fragment 分隔符为止。
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    if authority.is_empty() {
        return Err(ConnectionValidationError::InvalidEndpoint);
    }
    if authority.contains('@') {
        return Err(ConnectionValidationError::EmbeddedCredential);
    }
    Ok(trimmed.to_string())
}

/// 交付给角色查询方的非敏感连接配置（无凭据字段）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionView {
    pub id: String,
    pub name: String,
    pub service_type: ServiceType,
    pub endpoint: String,
    pub created_at: Option<String>,
}

impl ConnectionView {
    pub(crate) fn from_connection(c: &ModelConnection) -> Self {
        Self {
            id: c.id.clone(),
            name: c.name.clone(),
            service_type: c.service_type.clone(),
            endpoint: c.endpoint.clone(),
            created_at: c.created_at.clone(),
        }
    }
}

/// 交付给运行创建方的可冻结配置（含凭据引用，不含凭据明文）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FreezableConfig {
    pub id: String,
    pub name: String,
    pub service_type: ServiceType,
    pub endpoint: String,
    /// 凭据引用；运行时凭据解析与配置读取分开调用。
    pub credential_ref: String,
    pub created_at: Option<String>,
}

impl FreezableConfig {
    pub(crate) fn from_connection(c: &ModelConnection) -> Self {
        Self {
            id: c.id.clone(),
            name: c.name.clone(),
            service_type: c.service_type.clone(),
            endpoint: c.endpoint.clone(),
            credential_ref: c.credential_ref.clone(),
            created_at: c.created_at.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKER: &str = "TEST-SECRET-MARKER";

    /// SPEC「连接配置管理」：非法地址与缺失必需字段返回明确错误。
    #[test]
    fn endpoint_校验规则() {
        assert!(matches!(
            validate_endpoint("https://api.example.com/v1"),
            Ok(_)
        ));
        assert!(matches!(
            validate_endpoint("http://127.0.0.1:8080"),
            Ok(_)
        ));
        assert!(matches!(
            validate_endpoint("ftp://api.example.com"),
            Err(ConnectionValidationError::InvalidEndpoint)
        ));
        assert!(matches!(
            validate_endpoint("not a url"),
            Err(ConnectionValidationError::InvalidEndpoint)
        ));
        assert!(matches!(
            validate_endpoint("https://api.example.com"),
            Ok(_)
        ));
    }

    /// SPEC「连接配置管理」/「存储失败与敏感信息隔离」：
    /// endpoint 含内嵌认证信息被拒绝，错误信息脱敏，不含密钥标记。
    #[test]
    fn userinfo_被拒绝且错误脱敏() {
        let secret = format!("{MARKER}:hunter2");
        let err = validate_endpoint(&format!("https://{secret}@api.example.com"))
            .expect_err("userinfo 必须被拒绝");
        assert!(matches!(err, ConnectionValidationError::EmbeddedCredential));
        let text = err.to_string();
        assert!(!text.contains(MARKER), "错误回显了 userinfo：{text}");
        assert!(!text.contains("hunter2"), "错误回显了密码：{text}");
    }

    /// SPEC「连接配置管理」：缺失必需字段返回明确错误。
    #[test]
    fn 必填字段校验() {
        let st = ServiceType::OpenAiCompatible;
        assert!(matches!(
            validate_connection("", &st, "https://a.com", "cred"),
            Err(ConnectionValidationError::Required("name"))
        ));
        assert!(matches!(
            validate_connection("n", &st, "https://a.com", "  "),
            Err(ConnectionValidationError::Required("credential_ref"))
        ));
    }

    /// SPEC「凭据引用与受控解析」：DTO 序列化形态不含凭据字段或明文。
    #[test]
    fn view_dto_不含凭据字段() {
        let c = ModelConnection {
            id: "c1".into(),
            name: "n".into(),
            service_type: ServiceType::Anthropic,
            endpoint: "https://api.example.com".into(),
            credential_ref: "ref-1".into(),
            created_at: None,
        };
        let view = ConnectionView::from_connection(&c);
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("credential"), "ConnectionView 不应有凭据字段：{json}");
        assert!(json.contains("https://api.example.com"));

        let cfg = FreezableConfig::from_connection(&c);
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("ref-1"), "冻结配置应含凭据引用");
        // 引用不是密钥；本测试密钥值 MARKER 从未进入任何结构。
        assert!(!json.contains(MARKER));
    }

    /// ServiceType 契约：未知值前向兼容保留，序列化稳定。
    #[test]
    fn service_type_序列化契约() {
        assert_eq!(ServiceType::parse("openai_compatible"), ServiceType::OpenAiCompatible);
        assert_eq!(ServiceType::parse("anthropic"), ServiceType::Anthropic);
        let unknown = ServiceType::parse("bedrock_legacy");
        assert_eq!(unknown.as_str(), "bedrock_legacy");
        assert_eq!(
            serde_json::to_value(ServiceType::OpenAiCompatible).unwrap(),
            serde_json::json!("openai_compatible")
        );
        assert_eq!(
            serde_json::from_value::<ServiceType>(serde_json::json!("vertex_v1")).unwrap(),
            ServiceType::Other("vertex_v1".into())
        );
    }
}
