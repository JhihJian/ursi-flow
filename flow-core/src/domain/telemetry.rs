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
#[serde(rename_all = "camelCase")]
pub struct TelemetryEvent {
    pub category: EventCategory,
    pub name: String,
    pub phase: EventPhase,
    pub message: String,
    /// 附加属性。
    #[serde(default)]
    pub attributes: HashMap<String, serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_event() -> TelemetryEvent {
        TelemetryEvent {
            category: EventCategory::Tool,
            name: "bash.exec".to_string(),
            phase: EventPhase::Start,
            message: "执行脚本".to_string(),
            attributes: HashMap::new(),
        }
    }

    #[test]
    fn category_and_phase_serialize_snake_case() {
        assert_eq!(
            serde_json::to_string(&EventCategory::Tool).unwrap(),
            "\"tool\""
        );
        assert_eq!(
            serde_json::to_string(&EventCategory::Lifecycle).unwrap(),
            "\"lifecycle\""
        );
        assert_eq!(
            serde_json::to_string(&EventCategory::Artifact).unwrap(),
            "\"artifact\""
        );
        assert_eq!(
            serde_json::to_string(&EventPhase::Wait).unwrap(),
            "\"wait\""
        );
        assert_eq!(
            serde_json::to_string(&EventPhase::Progress).unwrap(),
            "\"progress\""
        );
    }

    #[test]
    fn event_roundtrip_keeps_all_fields() {
        let event = sample_event();
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"category\":\"tool\""));
        assert!(json.contains("\"phase\":\"start\""));
        let parsed: TelemetryEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.category, event.category);
        assert_eq!(parsed.name, event.name);
        assert_eq!(parsed.phase, event.phase);
        assert_eq!(parsed.message, event.message);
    }

    #[test]
    fn unknown_category_string_is_rejected() {
        assert!(serde_json::from_str::<EventCategory>("\"metrics\"").is_err());
        assert!(serde_json::from_str::<EventCategory>("\"Tool\"").is_err());
        assert!(serde_json::from_str::<EventPhase>("\"running\"").is_err());
        assert!(serde_json::from_str::<EventPhase>("\"waiting_approval\"").is_err());
        assert!(serde_json::from_str::<TelemetryEvent>(
            r#"{"category":"hack","name":"n","phase":"start","message":"m"}"#
        )
        .is_err());
    }
}
