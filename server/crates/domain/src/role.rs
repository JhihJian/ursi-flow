//! 角色与执行器定义：单次过程中可定制的能力。

use serde::{Deserialize, Serialize};

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

/// 执行器：一种执行器的标识与类型。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Executor {
    pub id: String,
    pub name: String,
    /// 执行器类型：mock 或具体 agent CLI。
    pub kind: String,
}
