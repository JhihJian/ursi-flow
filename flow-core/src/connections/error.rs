//! 连接域错误类型。所有 Display 输出均不含凭据明文。

use super::model::ConnectionValidationError;

/// 连接域统一业务错误。
///
/// 脱敏规则：
/// - `Validation` 只携带字段名与字段级原因，原因文本不回显字段值；
///   含 userinfo 的 endpoint 只报告检测到认证信息，不回显其内容。
/// - `CredentialMissing` 携带引用标识本身（引用不是密钥，用于定位配置），
///   绝不携带解析得到的任何值或上游响应体。
#[derive(Debug, thiserror::Error)]
pub enum ConnectionError {
    /// 字段级校验失败（字段名 + 脱敏原因）。
    #[error("校验失败：{0}")]
    Validation(ConnectionValidationError),

    /// 连接不存在或已删除。
    #[error("连接不存在：{0}")]
    NotFound(String),

    /// 连接仍被角色引用，拒绝删除。
    #[error("连接仍被角色引用，拒绝删除：{0}")]
    Conflict(String),

    /// 凭据引用不存在。
    #[error("凭据引用不存在：{0}")]
    CredentialMissing(String),

    /// 凭据来源不可达或拒绝访问（不含上游响应内容）。
    #[error("凭据访问失败：{0}")]
    CredentialAccessFailed(String),

    /// 执行器能力描述接口不可用，匹配结果未知。
    #[error("能力描述接口不可用，无法判断匹配结果：{0}")]
    CapabilityUnknown(String),

    /// 能力描述返回的内容无法解释为有效能力描述。
    #[error("能力描述内容无效：{0}")]
    CapabilityMismatch(String),

    /// 底层存储失败。
    #[error("存储错误：{0}")]
    Storage(String),
}

impl From<rusqlite::Error> for ConnectionError {
    fn from(e: rusqlite::Error) -> Self {
        // rusqlite 错误文本只含 SQL 或路径信息，不含凭据（凭据从不落库）。
        ConnectionError::Storage(e.to_string())
    }
}

impl From<ConnectionValidationError> for ConnectionError {
    fn from(e: ConnectionValidationError) -> Self {
        ConnectionError::Validation(e)
    }
}
