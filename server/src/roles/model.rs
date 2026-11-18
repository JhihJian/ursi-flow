//! 角色定义聚合：domain `Role` 基础字段 + 本域扩展配置。
//!
//! [`RoleDefinition`] 是本域聚合：
//! - `base: ursi_domain::Role`：共享契约（id、name、prompt、model、skills
//!   名称列表、mcp_servers 名称列表、executor_id）；
//! - `skill_package`：完整 Skills 文件包（见 [`super::skills`]）；
//! - `mcp_servers_config`：结构化 MCP 配置（见 [`super::mcp`]）；
//! - `connection_id`：模型连接选择；
//! - `executor_kind`：执行器类型选择（mock / Cli 名）。
//!
//! 连接选择规则（文档化的本域规则）：`connection_id` 与 `base.model` 均为
//! 必填。理由：角色的可执行性依赖具体模型端点，允许无连接的角色会把失败
//! 推迟到运行时；显式缺失由字段级校验错误定位。skills 名称列表
//! （`base.skills`）与文件包是两个维度：前者是流程侧引用的技能名清单，
//! 后者是本角色自带的完整文件内容。
//!
//! 校验顺序：先 domain `Role::validate()`，再本域扩展校验；任一失败
//! 返回字段级错误，调用方保留原定义（存储层不做任何写入）。

use ursi_domain::{ExecutorKind, Role, RoleError};

use super::error::RoleValidationError;
use super::mcp::McpServerConfig;
use super::skills::SkillPackage;

use ursi_agent_runtime::{RUNTIME_ACP, RUNTIME_PROFILE};

/// 测试共用基础 Role 构造（各文件测试模块复用）。
#[cfg(test)]
pub(crate) fn test_base(id: &str) -> Role {
    Role {
        id: id.into(),
        name: "评审员".into(),
        prompt: "严格评审".into(),
        model: Some("claude-sonnet".into()),
        skills: vec!["code-review".into()],
        mcp_servers: vec!["github".into()],
        executor_id: Some("exec-1".into()),
    }
}

/// 角色完整定义聚合。
#[derive(Debug, Clone)]
pub struct RoleDefinition {
    /// 共享契约基础字段。
    pub base: Role,
    /// 完整 Skills 文件包。
    pub skill_package: SkillPackage,
    /// 结构化 MCP 配置（服务器集合）。
    pub mcp_servers_config: Vec<McpServerConfig>,
    /// 模型连接选择（connections 连接标识）。必填。
    pub connection_id: String,
    /// 执行器类型选择。None 表示未选择（由执行装配决定）。
    pub executor_kind: Option<ExecutorKind>,
}

impl PartialEq for RoleDefinition {
    // domain Role 未实现 PartialEq，按字段逐一比较（完整等价语义）。
    fn eq(&self, other: &Self) -> bool {
        self.base.id == other.base.id
            && self.base.name == other.base.name
            && self.base.prompt == other.base.prompt
            && self.base.model == other.base.model
            && self.base.skills == other.base.skills
            && self.base.mcp_servers == other.base.mcp_servers
            && self.base.executor_id == other.base.executor_id
            && self.skill_package == other.skill_package
            && self.mcp_servers_config == other.mcp_servers_config
            && self.connection_id == other.connection_id
            && self.executor_kind == other.executor_kind
    }
}

impl Eq for RoleDefinition {}

/// 聚合校验错误：domain 校验错误与本域扩展校验错误的统一视图。
/// domain `RoleError` 未实现 Clone/Eq，这里不整体 derive。
#[derive(Debug, thiserror::Error)]
pub enum DefinitionValidationError {
    /// domain `Role::validate()` 的字段错误。
    #[error("{0}")]
    Base(#[from] RoleError),
    /// 本域扩展校验错误。
    #[error("{0}")]
    Extended(#[from] RoleValidationError),
}

impl RoleDefinition {
    /// 全量校验：domain 基础校验 + 本域扩展校验（含 MCP 逐台校验）。
    /// 连接存在性与能力匹配依赖网关，归 service 层保存流程，不在此处。
    pub fn validate(&self) -> Result<(), DefinitionValidationError> {
        self.base.validate().map_err(DefinitionValidationError::from)?;
        let extended = || -> Result<(), RoleValidationError> {
            if self.connection_id.trim().is_empty() {
                return Err(RoleValidationError::Field {
                    field: "connection_id",
                    reason: "必填：角色必须选择模型连接".into(),
                });
            }
            if self.base.model.as_deref().map(str::trim).unwrap_or("").is_empty() {
                return Err(RoleValidationError::Field {
                    field: "model",
                    reason: "必填：角色必须选择模型".into(),
                });
            }
            if self.executor_kind.as_ref().map(ExecutorKind::as_str) == Some(RUNTIME_ACP) {
                if self.base.model.as_deref() != Some(RUNTIME_PROFILE) {
                    return Err(RoleValidationError::Field {
                        field: "model",
                        reason: "runtime-acp 角色必须使用 runtime-profile，模型由 Runtime 固定".into(),
                    });
                }
                if !self.base.skills.is_empty() || !self.skill_package.files.is_empty() {
                    return Err(RoleValidationError::Field {
                        field: "skills",
                        reason: "runtime-acp 角色不支持 skills".into(),
                    });
                }
                if !self.base.mcp_servers.is_empty() || !self.mcp_servers_config.is_empty() {
                    return Err(RoleValidationError::Field {
                        field: "mcpServers",
                        reason: "runtime-acp 角色不支持 MCP".into(),
                    });
                }
            } else if self.skill_package.files.is_empty() {
                return Err(RoleValidationError::SkillMissingEntry(self.skill_package.entry.clone()));
            }
            // MCP 配置逐台校验；服务器名在本域配置内不允许重复。
            let mut seen = std::collections::BTreeSet::new();
            for cfg in &self.mcp_servers_config {
                cfg.validate()?;
                if !seen.insert(cfg.server().to_string()) {
                    return Err(RoleValidationError::Mcp {
                        server: cfg.server().to_string(),
                        reason: "服务器名在配置中重复".into(),
                    });
                }
            }
            Ok(())
        }();
        extended.map_err(DefinitionValidationError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roles::skills::SkillFile;

    fn definition(id: &str) -> RoleDefinition {
        RoleDefinition {
            base: test_base(id),
            skill_package: SkillPackage::new(vec![SkillFile::new("SKILL.md", "# 说明")]).unwrap(),
            mcp_servers_config: vec![McpServerConfig::Stdio {
                server: "fs".into(),
                command: "npx".into(),
                args: vec![],
                env: vec![("T".into(), "{{cred:t}}".into())],
            }],
            connection_id: "conn_main".into(),
            executor_kind: Some(ExecutorKind::Cli("claude-code".into())),
        }
    }

    /// SPEC「角色创建、查询与修改」：完整定义通过全量校验，各扩展字段在场。
    #[test]
    fn 完整定义通过校验() {
        let def = definition("r1");
        def.validate().unwrap();
        assert_eq!(def.connection_id, "conn_main");
        assert_eq!(
            def.executor_kind,
            Some(ExecutorKind::Cli("claude-code".into()))
        );
        assert_eq!(def.base.skills, vec!["code-review".to_string()]);
    }

    #[test]
    fn runtime_acp_requires_fixed_profile_and_no_capabilities() {
        let mut def = definition("r1");
        def.executor_kind = ExecutorKind::parse(RUNTIME_ACP);
        def.base.model = Some(RUNTIME_PROFILE.into());
        def.base.skills.clear();
        def.base.mcp_servers.clear();
        let mcp = std::mem::take(&mut def.mcp_servers_config);
        assert!(def.validate().unwrap_err().to_string().contains("skills"));
        def.skill_package = SkillPackage::for_executor(
            def.executor_kind.as_ref(), crate::roles::SKILL_ENTRY, vec![],
        ).unwrap();
        def.validate().unwrap();
        def.mcp_servers_config = mcp;
        assert!(def.validate().unwrap_err().to_string().contains("mcpServers"));
        def.mcp_servers_config.clear();
        def.base.mcp_servers.push("server".into());
        assert!(def.validate().unwrap_err().to_string().contains("mcpServers"));
        def.base.mcp_servers.clear();
        def.base.skills.push("skill".into());
        assert!(def.validate().unwrap_err().to_string().contains("skills"));
        def.base.skills.clear();
        for model in [None, Some("custom".into())] {
            def.base.model = model;
            assert!(def.validate().unwrap_err().to_string().contains("model"));
        }
        def.base.model = Some(RUNTIME_PROFILE.into());
        def.connection_id.clear();
        assert!(def.validate().unwrap_err().to_string().contains("connection_id"));
        def.connection_id = "conn_main".into();
        for kind in [None, Some(ExecutorKind::Mock), ExecutorKind::parse("claude-code")] {
            def.executor_kind = kind;
            assert!(matches!(def.validate(), Err(DefinitionValidationError::Extended(
                RoleValidationError::SkillMissingEntry(_)
            ))));
        }
    }

    /// SPEC「角色创建、查询与修改」：domain 基础校验失败返回字段级原因。
    #[test]
    fn 基础校验失败返回字段级错误() {
        let mut def = definition("r1");
        def.base.name = "  ".into();
        assert!(
            matches!(def.validate(), Err(DefinitionValidationError::Base(RoleError::EmptyName))),
            "空名称必须由 domain 校验拒绝"
        );
    }

    /// SPEC「角色创建、查询与修改」：本域扩展校验拒绝缺失的连接选择与
    /// 模型选择，以及非法 MCP 配置；错误可定位字段或服务器。
    #[test]
    fn 扩展校验拒绝缺失连接选择与非法_mcp() {
        let mut def = definition("r1");
        def.connection_id = "  ".into();
        let err = def.validate().unwrap_err();
        assert!(err.to_string().contains("connection_id"), "实际：{err}");

        def.connection_id = "conn_main".into();
        def.base.model = None;
        assert!(def.validate().unwrap_err().to_string().contains("model"));

        def.base.model = Some("claude-sonnet".into());
        def.mcp_servers_config.push(McpServerConfig::Stdio {
            server: "fs".into(),
            command: "dup".into(),
            args: vec![],
            env: vec![],
        });
        let err = def.validate().unwrap_err();
        assert!(err.to_string().contains("fs"), "重复服务器名必须可定位：{err}");
    }
}
