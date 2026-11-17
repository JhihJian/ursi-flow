//! 运行产物：节点产生的交付物。

use serde::{Deserialize, Serialize};

/// 运行产物。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub name: String,
    pub path: String,
    /// 是否必需。
    #[serde(default)]
    pub required: bool,
    /// 内容类型。
    #[serde(default)]
    pub media_type: Option<String>,
}
