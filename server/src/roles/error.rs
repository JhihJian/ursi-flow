//! 角色域错误类型。Display 输出不含凭据明文：
//! - 校验错误只携带字段名、包内相对路径与脱敏原因（路径是包内相对路径，非敏感）；
//! - 连接相关错误只携带连接标识（引用标识，不是密钥）；
//! - MCP 明文敏感值被拒绝时，错误只报告服务器名与字段位置，不回显被拒绝的值。

/// 角色字段级校验错误。原因文本脱敏，不回显敏感字段值。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RoleValidationError {
    /// 基础或扩展字段不合法。
    #[error("字段 {field} {reason}")]
    Field {
        field: &'static str,
        reason: String,
    },
    /// skills 包内路径非法（空、绝对、`..` 穿越、空段等）。
    #[error("skills 路径非法：{0}")]
    SkillPath(String),
    /// skills 包内路径重复。
    #[error("skills 文件路径重复：{0}")]
    SkillDuplicate(String),
    /// skills 包缺少入口文件。
    #[error("skills 包缺少入口文件：{0}")]
    SkillMissingEntry(String),
    /// MCP 配置不合法。`server` 是服务器名，`reason` 脱敏。
    #[error("MCP 服务器 {server}：{reason}")]
    Mcp { server: String, reason: String },
}

/// 角色域统一业务错误。Display 输出不含凭据明文（密钥值从不进入本域）。
#[derive(Debug, thiserror::Error)]
pub enum RolesError {
    /// 字段级校验失败。
    #[error("角色校验失败：{0}")]
    Validation(#[from] RoleValidationError),

    /// 角色不存在或已删除。
    #[error("角色不存在：{0}")]
    NotFound(String),

    /// 角色仍被流程引用，拒绝删除。
    #[error("角色仍被流程引用，拒绝删除：{0}")]
    Conflict(String),

    /// 模型连接缺失、能力不匹配或能力未知（文本含连接标识用于定位，不含凭据）。
    #[error("模型连接校验失败：{0}")]
    Connection(String),

    /// 连接网关调用失败（登记/解除/查询异常）。
    #[error("连接网关调用失败：{0}")]
    Gateway(String),

    /// 底层存储失败。
    #[error("存储错误：{0}")]
    Storage(String),
}

impl From<rusqlite::Error> for RolesError {
    fn from(e: rusqlite::Error) -> Self {
        // ToSqlConversionFailure 是本模块的内部通道，解包还原域错误；
        // 其余错误文本只含 SQL 或路径信息，映射为 Storage。
        if let rusqlite::Error::ToSqlConversionFailure(inner) = e {
            match inner.downcast::<RolesError>() {
                Ok(domestic) => return *domestic,
                Err(inner) => return RolesError::Storage(inner.to_string()),
            }
        }
        RolesError::Storage(e.to_string())
    }
}

impl From<crate::storage::ContentError> for RolesError {
    fn from(e: crate::storage::ContentError) -> Self {
        match e {
            // 落盘边界校验拒绝（含 symlink 逃逸）：属于输入路径问题。
            crate::storage::ContentError::InvalidPath(p) => {
                RolesError::Validation(RoleValidationError::SkillPath(p))
            }
            other => RolesError::Storage(other.to_string()),
        }
    }
}

impl From<crate::storage::StoreError> for RolesError {
    fn from(e: crate::storage::StoreError) -> Self {
        RolesError::Storage(e.to_string())
    }
}

impl From<super::model::DefinitionValidationError> for RolesError {
    fn from(e: super::model::DefinitionValidationError) -> Self {
        match e {
            super::model::DefinitionValidationError::Base(b) => {
                RolesError::Validation(RoleValidationError::Field {
                    field: "base",
                    reason: b.to_string(),
                })
            }
            super::model::DefinitionValidationError::Extended(x) => {
                RolesError::Validation(x)
            }
        }
    }
}

impl From<super::gateway::GatewayError> for RolesError {
    fn from(e: super::gateway::GatewayError) -> Self {
        RolesError::Gateway(e.to_string())
    }
}
