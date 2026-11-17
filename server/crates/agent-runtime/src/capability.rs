//! 能力配置契约：prompt、model、skills、mcp_servers 跨 ACP 传递与校验。
//!
//! 序列化形态与 domain 的 `Role` camelCase 字段保持一致，能力配置经
//! session/new 下发给沙箱内 Adapter，CLI 特有参数与文件渲染由 Adapter
//! 在沙箱内执行，server 不拼接 CLI 命令。未知能力字段返回明确错误。

use serde::{Deserialize, Serialize};

/// 角色能力配置：跨 ACP 传递的完整契约字段。
///
/// 序列化为 camelCase（与 domain::Role 一致）。`deny_unknown_fields`
/// 使未知字段在反序列化时报错，映射为 [`CapabilityError::Unsupported`]。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityConfig {
    /// 角色提示词。
    #[serde(default)]
    pub prompt: String,
    /// 模型标识。
    #[serde(default)]
    pub model: Option<String>,
    /// 技能列表。
    #[serde(default)]
    pub skills: Vec<String>,
    /// MCP 服务列表。
    #[serde(default)]
    pub mcp_servers: Vec<String>,
}

impl CapabilityConfig {
    /// 从 domain `Role` 提取能力配置子集。
    ///
    /// server 的角色定义是能力配置的来源；这里只取契约字段，CLI 特有
    /// 参数（如 executor_id）不进 ACP 传递。
    pub fn from_role(role: &ursi_domain::Role) -> Self {
        Self {
            prompt: role.prompt.clone(),
            model: role.model.clone(),
            skills: role.skills.clone(),
            mcp_servers: role.mcp_servers.clone(),
        }
    }

    /// 序列化为 JSON，供跨 ACP 传递前确认字段完整。
    pub fn to_json(&self) -> Result<String, CapabilityError> {
        serde_json::to_string(self)
            .map_err(|e| CapabilityError::Unsupported(format!("能力配置序列化失败：{e}")))
    }

    /// 从 JSON 反序列化，未知字段返回 [`CapabilityError::Unsupported`]。
    pub fn from_json(json: &str) -> Result<Self, CapabilityError> {
        serde_json::from_str(json).map_err(|e| CapabilityError::Unsupported(format!(
            "能力配置包含未知或不支持的字段：{e}"
        )))
    }
}

/// 能力配置错误。
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum CapabilityError {
    /// 未知或不支持的能力字段，明确拒绝而非静默忽略。
    #[error("不支持的能力字段：{0}")]
    Unsupported(String),
}

/// 由任意 JSON 值解析能力配置，供 ACP 帧处理路径复用。
pub fn capability_result_from_json(value: &serde_json::Value) -> Result<CapabilityConfig, CapabilityError> {
    serde_json::from_value(value.clone()).map_err(|e| CapabilityError::Unsupported(format!(
        "能力配置包含未知或不支持的字段：{e}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SPEC 验收（能力配置契约）：跨 ACP 传递后配置字段保持完整。
    #[test]
    fn capability_config_roundtrip_keeps_all_fields() {
        let config = CapabilityConfig {
            prompt: "严格评审提交".to_string(),
            model: Some("claude-sonnet".to_string()),
            skills: vec!["code-review".to_string(), "rust".to_string()],
            mcp_servers: vec!["github".to_string()],
        };
        let json = serde_json::to_string(&config).unwrap();
        // camelCase 形态与 domain::Role 对齐。
        assert!(json.contains("\"mcpServers\""));

        let parsed: CapabilityConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, config, "serde 往返后字段完整");
        // 缺省字段：model 缺省为 None，列表缺省为空。
        let minimal: CapabilityConfig =
            serde_json::from_str(r#"{ "prompt": "x" }"#).unwrap();
        assert_eq!(minimal.model, None);
        assert!(minimal.skills.is_empty());
        assert!(minimal.mcp_servers.is_empty());
    }

    /// SPEC 验收（能力配置契约）：未知或不支持能力返回明确错误。
    #[test]
    fn unknown_capability_field_returns_unsupported_error() {
        let result = CapabilityConfig::from_json(
            r#"{ "prompt": "x", "temperature": 0.7 }"#,
        );
        let err = result.expect_err("未知字段应报错");
        assert!(
            matches!(err, CapabilityError::Unsupported(ref m) if m.contains("temperature")),
            "错误应指明未知字段，实际 {err:?}"
        );

        let result = capability_result_from_json(&serde_json::json!({
            "prompt": "x", "skills": [], "cliFlags": ["--fast"]
        }));
        assert!(matches!(
            result,
            Err(CapabilityError::Unsupported(_))
        ));
    }

    /// SPEC 验收（能力配置契约）：配置来源与传递形态。
    #[test]
    fn capability_from_role_keeps_contract_fields_only() {
        let role = ursi_domain::Role {
            id: "reviewer".to_string(),
            name: "评审员".to_string(),
            prompt: "严格评审".to_string(),
            model: Some("claude-sonnet".to_string()),
            skills: vec!["code-review".to_string()],
            mcp_servers: vec!["github".to_string()],
            executor_id: Some("mock-1".to_string()),
        };
        let config = CapabilityConfig::from_role(&role);
        assert_eq!(config.prompt, "严格评审");
        assert_eq!(config.model.as_deref(), Some("claude-sonnet"));
        assert_eq!(config.skills, vec!["code-review"]);
        assert_eq!(config.mcp_servers, vec!["github"]);
        // JSON 形态可整体下发（供 session/new config 字段）。
        let json = config.to_json().unwrap();
        assert!(json.contains("\"mcpServers\":[\"github\"]"));
    }
}
