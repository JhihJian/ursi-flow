//! 角色与执行器定义：单次过程中可定制的能力。

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// 角色：单次过程中可定制的角色能力。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: String,
    pub name: String,
    /// 角色提示词。
    #[serde(default)]
    pub prompt: String,
    /// 模型标识。
    #[serde(default)]
    pub model: Option<String>,
    /// 技能列表。
    #[serde(default)]
    pub skills: Vec<String>,
    /// MCP 工具列表。
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    /// 执行器标识。
    #[serde(default)]
    pub executor_id: Option<String>,
}

/// 角色字段校验错误。
#[derive(Debug, thiserror::Error)]
pub enum RoleError {
    #[error("角色 ID 不能为空")]
    EmptyId,
    #[error("角色名称不能为空")]
    EmptyName,
    #[error("角色 skills[{index}] 为空字符串")]
    EmptySkill { index: usize },
    #[error("角色 mcp_servers[{index}] 为空字符串")]
    EmptyMcpServer { index: usize },
}

impl Role {
    /// 纯字段校验：id/name 必填非空，skills 与 mcp_servers 元素非空字符串；
    /// Prompt 允许为空。角色引用是否存在由 server 的 workflows/roles 模块校验。
    pub fn validate(&self) -> Result<(), RoleError> {
        if self.id.trim().is_empty() {
            return Err(RoleError::EmptyId);
        }
        if self.name.trim().is_empty() {
            return Err(RoleError::EmptyName);
        }
        for (index, skill) in self.skills.iter().enumerate() {
            if skill.trim().is_empty() {
                return Err(RoleError::EmptySkill { index });
            }
        }
        for (index, server) in self.mcp_servers.iter().enumerate() {
            if server.trim().is_empty() {
                return Err(RoleError::EmptyMcpServer { index });
            }
        }
        Ok(())
    }
}

/// 执行器类型：mock 或真实 agent CLI。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutorKind {
    Mock,
    /// 真实 agent CLI，携带 CLI 名（如 "claude-code"）。
    Cli(String),
}

impl ExecutorKind {
    /// mock 类型的序列化标签。
    pub const MOCK_TAG: &'static str = "mock";

    /// 是否为 mock 类型。
    pub fn is_mock(&self) -> bool {
        matches!(self, ExecutorKind::Mock)
    }

    /// 序列化标签：mock 为 "mock"，CLI 为 CLI 名本身。
    pub fn as_str(&self) -> &str {
        match self {
            ExecutorKind::Mock => Self::MOCK_TAG,
            ExecutorKind::Cli(name) => name,
        }
    }

    /// 解析字符串："mock" 得到 Mock，其余非空字符串视为 CLI 名。
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        if s.is_empty() {
            return None;
        }
        if s == Self::MOCK_TAG {
            Some(ExecutorKind::Mock)
        } else {
            Some(ExecutorKind::Cli(s.to_string()))
        }
    }
}

impl fmt::Display for ExecutorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for ExecutorKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ExecutorKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        ExecutorKind::parse(&s)
            .ok_or_else(|| serde::de::Error::custom("executor kind 不能为空字符串"))
    }
}

/// 执行器：一种执行器的标识与类型。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Executor {
    pub id: String,
    pub name: String,
    /// 执行器类型：mock 或具体 agent CLI。
    pub kind: ExecutorKind,
}

impl Executor {
    /// 执行器是否为 mock 类型。
    pub fn kind_is_mock(&self) -> bool {
        self.kind.is_mock()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_role_and_keeps_all_fields() {
        let role: Role = serde_json::from_str(
            r#"{
                "id": "reviewer", "name": "评审员", "prompt": "严格评审",
                "model": "claude-sonnet", "skills": ["code-review"],
                "mcpServers": ["github"], "executorId": "mock-1"
            }"#,
        )
        .unwrap();
        assert_eq!(role.id, "reviewer");
        assert_eq!(role.name, "评审员");
        assert_eq!(role.prompt, "严格评审");
        assert_eq!(role.model.as_deref(), Some("claude-sonnet"));
        assert_eq!(role.skills, vec!["code-review"]);
        assert_eq!(role.mcp_servers, vec!["github"]);
        assert_eq!(role.executor_id.as_deref(), Some("mock-1"));
    }

    #[test]
    fn validate_accepts_role_with_empty_prompt() {
        let role = Role {
            id: "r1".to_string(),
            name: "开发".to_string(),
            prompt: String::new(),
            model: None,
            skills: vec!["rust".to_string()],
            mcp_servers: vec![],
            executor_id: None,
        };
        role.validate().unwrap();
    }

    #[test]
    fn validate_rejects_empty_id_and_name() {
        let mut role = Role {
            id: "  ".to_string(),
            name: "开发".to_string(),
            prompt: String::new(),
            model: None,
            skills: vec![],
            mcp_servers: vec![],
            executor_id: None,
        };
        assert!(matches!(role.validate(), Err(RoleError::EmptyId)));

        role.id = "r1".to_string();
        role.name = " ".to_string();
        assert!(matches!(role.validate(), Err(RoleError::EmptyName)));
    }

    #[test]
    fn validate_rejects_blank_skill_and_mcp_server() {
        let mut role = Role {
            id: "r1".to_string(),
            name: "开发".to_string(),
            prompt: String::new(),
            model: None,
            skills: vec!["rust".to_string(), "  ".to_string()],
            mcp_servers: vec![],
            executor_id: None,
        };
        assert!(matches!(
            role.validate(),
            Err(RoleError::EmptySkill { index: 1 })
        ));

        role.skills = vec![];
        role.mcp_servers = vec![String::new()];
        assert!(matches!(
            role.validate(),
            Err(RoleError::EmptyMcpServer { index: 0 })
        ));
    }

    #[test]
    fn executor_kind_serializes_as_string_tag() {
        let executor = Executor {
            id: "e1".to_string(),
            name: "Claude Code".to_string(),
            kind: ExecutorKind::Cli("claude-code".to_string()),
        };
        let json = serde_json::to_string(&executor).unwrap();
        assert!(json.contains("\"kind\":\"claude-code\""));

        let parsed: Executor = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.kind, ExecutorKind::Cli("claude-code".to_string()));
        assert!(!parsed.kind_is_mock());
    }

    #[test]
    fn executor_kind_mock_tag_and_parse() {
        assert_eq!(
            serde_json::to_string(&ExecutorKind::Mock).unwrap(),
            "\"mock\""
        );
        assert_eq!(ExecutorKind::parse("mock"), Some(ExecutorKind::Mock));
        assert_eq!(
            ExecutorKind::parse("gemini-cli"),
            Some(ExecutorKind::Cli("gemini-cli".to_string()))
        );
        assert_eq!(ExecutorKind::parse(""), None);
        assert_eq!(ExecutorKind::parse("   "), None);
        assert!(serde_json::from_str::<ExecutorKind>("\"\"").is_err());
    }

    #[test]
    fn executor_kind_deserializes_legacy_plain_string_json() {
        // 历史 JSON 中 kind 为普通字符串，可直接反序列化。
        let legacy: Executor = serde_json::from_str(
            r#"{"id": "e2", "name": "Mock 执行器", "kind": "mock"}"#,
        )
        .unwrap();
        assert!(legacy.kind_is_mock());

        let legacy: ExecutorKind = serde_json::from_str("\"claude-code\"").unwrap();
        assert_eq!(legacy, ExecutorKind::Cli("claude-code".to_string()));
    }
}
