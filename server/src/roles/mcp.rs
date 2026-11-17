//! 结构化 MCP 配置：区分 stdio（command、args）与 http（url、headers）。
//!
//! - stdio：本地命令及参数，`env` 中敏感值必须用凭据引用；
//! - http：URL、请求头；敏感头值（如 Authorization）必须用凭据引用
//!   `{{cred:xxx}}` 或 `vault://` 风格引用前缀。
//!
//! 敏感值规则：凡判定为敏感的字段（stdio `env`、http `Authorization` /
//! `X-Api-Key` 头），其值必须是凭据引用。引用形态：
//! - `{{cred:标识}}` 模板形式；
//! - `vault://`、`env:` 等既有引用 scheme 前缀（与 connections 凭据引用一致）。
//!
//! 出现明文敏感值（非引用形态）一律拒绝，错误只报告服务器名与字段位置，
//! 不回显被拒绝的值。非敏感字段（普通 url、args、普通头）原样保存并完整读回。

use serde::{Deserialize, Serialize};

use super::error::RoleValidationError;

/// MCP 传输类型标签。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    /// 本地命令（command + args + env）。
    Stdio,
    /// HTTP 服务（url + headers）。
    Http,
}

/// 一台 MCP 服务器：服务器名 + 具体传输配置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpServerConfig {
    /// stdio：本地命令。
    Stdio {
        server: String,
        command: String,
        #[serde(default)]
        args: Vec<String>,
        /// 环境变量；值必须为凭据引用，明文拒绝。
        #[serde(default)]
        env: Vec<(String, String)>,
    },
    /// http：远程服务。
    Http {
        server: String,
        url: String,
        /// 请求头；敏感头值必须为凭据引用，明文拒绝。
        #[serde(default)]
        headers: Vec<(String, String)>,
    },
}

impl McpServerConfig {
    /// 服务器名。
    pub fn server(&self) -> &str {
        match self {
            Self::Stdio { server, .. } | Self::Http { server, .. } => server,
        }
    }

    /// 传输类型。
    pub fn transport(&self) -> McpTransport {
        match self {
            Self::Stdio { .. } => McpTransport::Stdio,
            Self::Http { .. } => McpTransport::Http,
        }
    }

    /// 校验一台服务器配置：服务器名非空、必填项齐备、敏感值必须是引用。
    /// 返回规范化 url（http 配置去除首尾空白）。
    pub fn validate(&self) -> Result<(), RoleValidationError> {
        let mcp_err = |reason: &str| RoleValidationError::Mcp {
            server: self.server().to_string(),
            reason: reason.to_string(),
        };
        if self.server().trim().is_empty() {
            return Err(mcp_err("服务器名不能为空"));
        }
        match self {
            Self::Stdio { command, env, .. } => {
                if command.trim().is_empty() {
                    return Err(mcp_err("command 必填"));
                }
                for (key, value) in env {
                    if key.trim().is_empty() {
                        return Err(mcp_err("env 键不能为空"));
                    }
                    if !is_credential_ref(value) {
                        return Err(mcp_err(&format!("env[{key}] 含明文敏感值，必须使用凭据引用（不回显其内容）")));
                    }
                }
            }
            Self::Http { url, headers, .. } => {
                let trimmed = url.trim();
                let ok = ["http://", "https://"].iter().any(|s| trimmed.starts_with(s))
                    && trimmed.len() > "http://x".len();
                if !ok {
                    return Err(mcp_err("url 必须是 http(s) 地址"));
                }
                for (key, value) in headers {
                    if key.trim().is_empty() {
                        return Err(mcp_err("头名不能为空"));
                    }
                    if is_sensitive_header(key) && !is_credential_ref(value) {
                        return Err(mcp_err(&format!(
                            "请求头 {key} 含明文敏感值，必须使用凭据引用（不回显其内容）"
                        )));
                    }
                }
            }
        }
        Ok(())
    }

    /// 稳定存储标签：stdio / http。
    pub fn transport_tag(&self) -> &'static str {
        match self {
            Self::Stdio { .. } => "stdio",
            Self::Http { .. } => "http",
        }
    }
}

/// 判定值是否为合法凭据引用形态：`{{cred:xxx}}` 模板或引用 scheme 前缀。
pub fn is_credential_ref(value: &str) -> bool {
    let v = value.trim();
    if v.starts_with("{{cred:") && v.ends_with("}}") && v.len() > "{{cred:}}".len() {
        return true;
    }
    ["vault://", "env:", "secret://", "file:"]
        .iter()
        .any(|prefix| v.starts_with(prefix))
}

/// 敏感请求头判定：认证类头的值必须走凭据引用。
fn is_sensitive_header(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "authorization" | "x-api-key" | "api-key" | "proxy-authorization" | "cookie"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SPEC「Skills 完整文件包与 MCP 配置」：合法 stdio 与 http 配置通过校验。
    #[test]
    fn 合法配置通过校验() {
        let stdio = McpServerConfig::Stdio {
            server: "fs".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "@mcp/fs".into()],
            env: vec![("TOKEN".into(), "{{cred:mcp-token}}".into())],
        };
        stdio.validate().unwrap();
        assert_eq!(stdio.transport_tag(), "stdio");

        let http = McpServerConfig::Http {
            server: "search".into(),
            url: "https://mcp.example.com/v1".into(),
            headers: vec![
                ("Authorization".into(), "vault://keys/mcp".into()),
                ("X-Request-Id".into(), "trace-42".into()),
            ],
        };
        http.validate().unwrap();
        assert_eq!(http.transport_tag(), "http");
    }

    /// SPEC「Skills 完整文件包与 MCP 配置」：明文敏感值被拒绝且错误脱敏，
    /// 不回显被拒绝的值；非法字段（空 command、坏 url、空键）被拒绝。
    #[test]
    fn 明文敏感值拒绝且错误脱敏() {
        const SECRET: &str = "sk-PLAIN-SECRET-MARKER";
        // stdio env 明文。
        let stdio = McpServerConfig::Stdio {
            server: "fs".into(),
            command: "npx".into(),
            args: vec![],
            env: vec![("TOKEN".into(), SECRET.into())],
        };
        let err = stdio.validate().unwrap_err();
        assert!(
            !err.to_string().contains(SECRET),
            "错误回显了明文敏感值：{err}"
        );
        assert!(err.to_string().contains("fs"), "错误应含服务器名便于定位");
        assert!(err.to_string().contains("TOKEN"), "错误应含字段位置");

        // http Authorization 明文。
        let http = McpServerConfig::Http {
            server: "search".into(),
            url: "https://mcp.example.com".into(),
            headers: vec![("Authorization".into(), format!("Bearer {SECRET}"))],
        };
        let err = http.validate().unwrap_err();
        assert!(!err.to_string().contains(SECRET), "错误回显了明文：{err}");
        // 同一头用引用形态即合法。
        let http_ref = McpServerConfig::Http {
            server: "search".into(),
            url: "https://mcp.example.com".into(),
            headers: vec![("Authorization".into(), "{{cred:search-key}}".into())],
        };
        http_ref.validate().unwrap();

        // 非法字段：空 command、坏 url、空服务器名、空头名。
        let bad_command = McpServerConfig::Stdio {
            server: "fs".into(),
            command: "  ".into(),
            args: vec![],
            env: vec![],
        };
        assert!(bad_command.validate().is_err());
        let bad_url = McpServerConfig::Http {
            server: "s".into(),
            url: "not-a-url".into(),
            headers: vec![],
        };
        assert!(bad_url.validate().is_err());
        let empty_server = McpServerConfig::Stdio {
            server: "".into(),
            command: "x".into(),
            args: vec![],
            env: vec![],
        };
        assert!(empty_server.validate().is_err());
    }

    /// SPEC「Skills 完整文件包与 MCP 配置」：合法配置经 JSON 序列化完整读回，
    /// tagged enum 区分 stdio/http 且字段不丢。
    #[test]
    fn 序列化完整读回() {
        let configs = vec![
            McpServerConfig::Stdio {
                server: "fs".into(),
                command: "npx".into(),
                args: vec!["-y".into(), "pkg".into()],
                env: vec![("T".into(), "vault://k".into())],
            },
            McpServerConfig::Http {
                server: "search".into(),
                url: "https://mcp.example.com".into(),
                headers: vec![("X-Api-Key".into(), "env:MCP_KEY".into())],
            },
        ];
        let json = serde_json::to_string(&configs).unwrap();
        let back: Vec<McpServerConfig> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, configs);
        // tagged 形态：类型标签在场。
        assert!(json.contains("\"type\":\"stdio\""));
        assert!(json.contains("\"type\":\"http\""));
    }
}
