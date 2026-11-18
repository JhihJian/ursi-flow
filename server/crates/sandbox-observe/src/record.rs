//! 观测记录模型：来源、关联标识、时间、结果与已脱敏摘要。

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 当前 Unix 时间（毫秒）；时钟早于纪元时返回 0。
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 记录来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordSource {
    /// Channel：命令结果、连接状态与传输计数。
    Channel,
    /// session-service：agent 会话事件。
    SessionsService,
    /// 监督器：进程退出事件。
    Supervisor,
    /// 传输层流量摘要。
    Transport,
}

/// 记录类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    /// agent 会话事件（session-service）。
    SessionEvent,
    /// 命令执行结果（实际执行方上报）。
    CommandResult,
    /// 进程退出（监督器上报）。
    ProcessExit,
    /// 连接状态变化（Channel）。
    ConnectionState,
    /// 传输流量摘要（计数与状态，不含载荷）。
    TrafficSummary,
}

/// 记录结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Ok,
    Failed,
    Cancelled,
    Unknown,
}

/// 沙箱观测记录。`summary` 由生产方经脱敏助手处理后填充，`attrs` 只放
/// 非敏感的结构化属性。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserveRecord {
    pub source: RecordSource,
    pub sandbox_id: Option<String>,
    pub run_id: Option<String>,
    pub node_id: Option<String>,
    pub session_id: Option<String>,
    pub command_ref: Option<String>,
    /// 记录时间（Unix 毫秒）。
    pub time_ms: u64,
    pub kind: RecordKind,
    pub outcome: Outcome,
    /// 已脱敏的摘要文本。
    pub summary: String,
    pub attrs: HashMap<String, serde_json::Value>,
}

/// 查询关联标识：按 session_id、command_ref 或 sandbox_id 任一匹配。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Correlation {
    pub session_id: Option<String>,
    pub command_ref: Option<String>,
    pub sandbox_id: Option<String>,
}

impl Correlation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn by_session(id: impl Into<String>) -> Self {
        Self {
            session_id: Some(id.into()),
            ..Self::default()
        }
    }

    pub fn by_command(command_ref: impl Into<String>) -> Self {
        Self {
            command_ref: Some(command_ref.into()),
            ..Self::default()
        }
    }

    pub fn by_sandbox(id: impl Into<String>) -> Self {
        Self {
            sandbox_id: Some(id.into()),
            ..Self::default()
        }
    }

    pub fn with_session(mut self, id: impl Into<String>) -> Self {
        self.session_id = Some(id.into());
        self
    }

    pub fn with_command(mut self, command_ref: impl Into<String>) -> Self {
        self.command_ref = Some(command_ref.into());
        self
    }

    pub fn with_sandbox(mut self, id: impl Into<String>) -> Self {
        self.sandbox_id = Some(id.into());
        self
    }

    /// 是否没有任何关联条件；空条件查询不返回记录。
    pub fn is_empty(&self) -> bool {
        self.session_id.is_none() && self.command_ref.is_none() && self.sandbox_id.is_none()
    }
}

impl ObserveRecord {
    /// 是否命中任一非空关联条件。
    pub fn matches_correlation(&self, correlation: &Correlation) -> bool {
        if correlation.is_empty() {
            return false;
        }
        let eq =
            |a: &Option<String>, b: Option<&str>| a.as_deref() == b;
        eq(&self.session_id, correlation.session_id.as_deref())
            || eq(&self.command_ref, correlation.command_ref.as_deref())
            || eq(&self.sandbox_id, correlation.sandbox_id.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_record() -> ObserveRecord {
        ObserveRecord {
            source: RecordSource::SessionsService,
            sandbox_id: Some("sb-1".to_string()),
            run_id: Some("run-1".to_string()),
            node_id: None,
            session_id: Some("s-1".to_string()),
            command_ref: Some("cmd-1".to_string()),
            time_ms: 1_700_000_000_000,
            kind: RecordKind::SessionEvent,
            outcome: Outcome::Cancelled,
            summary: "会话摘要".to_string(),
            attrs: HashMap::from([("k".to_string(), serde_json::json!({"a": 1}))]),
        }
    }

    #[test]
    fn record_roundtrip_preserves_fields() {
        let record = sample_record();
        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains("\"kind\":\"session_event\""));
        assert!(json.contains("\"outcome\":\"cancelled\""));
        assert!(json.contains("\"source\":\"sessions_service\""));
        assert!(json.contains("\"commandRef\":\"cmd-1\""));
        let parsed: ObserveRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.source, record.source);
        assert_eq!(parsed.kind, record.kind);
        assert_eq!(parsed.outcome, record.outcome);
        assert_eq!(parsed.summary, record.summary);
        assert_eq!(parsed.sandbox_id.as_deref(), Some("sb-1"));
        assert_eq!(parsed.attrs["k"], serde_json::json!({"a": 1}));
    }

    #[test]
    fn correlation_matches_any_set_identifier() {
        let record = sample_record();
        assert!(record.matches_correlation(&Correlation::by_session("s-1")));
        assert!(record.matches_correlation(&Correlation::by_command("cmd-1")));
        assert!(record.matches_correlation(&Correlation::by_sandbox("sb-1")));
        assert!(!record.matches_correlation(&Correlation::by_session("s-2")));
        assert!(!record.matches_correlation(&Correlation::by_command("cmd-9")));
        // 空条件不命中任何记录。
        assert!(!record.matches_correlation(&Correlation::new()));
        // 组合条件任一命中即可。
        let combined = Correlation::new().with_command("c-9").with_sandbox("sb-1");
        assert!(record.matches_correlation(&combined));
    }
}
