//! 观测事件契约：节点状态、工具轨迹、日志、产物发布的统一表示。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 事件类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventCategory {
    Lifecycle,
    Node,
    Tool,
    Log,
    Artifact,
}

/// 事件阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventPhase {
    Start,
    Progress,
    Finish,
    Wait,
}

/// 观测事件。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryEvent {
    pub category: EventCategory,
    pub name: String,
    pub phase: EventPhase,
    pub message: String,
    /// 附加属性。
    #[serde(default)]
    pub attributes: HashMap<String, serde_json::Value>,
}
