//! 传输观测预留：流量摘要只记录连接状态、方向与字节计数。
//!
//! 类型上不携带 payload 字段：完整抓包、协议内容分析和独立流量监控系统
//! 不在此阶段实现，任何传输观测都不得引入业务载荷。
//!
//! 接入新的观测消费者不改变沙箱生命周期和 agent 会话协议：channel 与
//! agent-runtime 的类型不出现在本 crate 依赖中，生产方把自身事件映射为
//! [`TrafficSummary`] 与 [`crate::record::ObserveRecord`]，消费方只面向
//! [`crate::collector::ObserverCollector`] 编程，双方仅通过本 crate 的
//! 记录类型解耦。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::record::{now_ms, ObserveRecord, Outcome, RecordKind, RecordSource};

/// 通道类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelKind {
    /// SSH 执行、终端与 SFTP。
    Ssh,
    /// ACP 会话传输。
    Acp,
    /// HTTP/WebSocket 代理。
    Http,
    /// Gateway 隧道。
    Tunnel,
}

/// 传输方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrafficDirection {
    Inbound,
    Outbound,
}

/// 连接状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrafficState {
    Open,
    Closed,
    Error,
}

/// 传输流量摘要：连接状态、方向与字节计数，不含任何业务载荷。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficSummary {
    pub channel_kind: ChannelKind,
    pub sandbox_id: String,
    pub direction: TrafficDirection,
    pub bytes: u64,
    pub state: TrafficState,
}

impl TrafficSummary {
    /// 映射为观测记录（kind = TrafficSummary，source = Transport）。
    ///
    /// `summary` 只包含通道、方向、状态与字节数的脱敏安全文本；调用方可
    /// 通过 `session_id` 等关联标识把传输摘要挂到同一执行链上。
    pub fn to_record(&self, session_id: Option<String>) -> ObserveRecord {
        let mut attrs = HashMap::from([
            (
                "channel_kind".to_string(),
                serde_json::json!(self.channel_kind),
            ),
            ("direction".to_string(), serde_json::json!(self.direction)),
            ("state".to_string(), serde_json::json!(self.state)),
            ("bytes".to_string(), serde_json::json!(self.bytes)),
        ]);
        if let Some(ref session) = session_id {
            attrs.insert("session_id".to_string(), serde_json::json!(session));
        }
        ObserveRecord {
            source: RecordSource::Transport,
            sandbox_id: Some(self.sandbox_id.clone()),
            run_id: None,
            node_id: None,
            session_id,
            command_ref: None,
            time_ms: now_ms(),
            kind: RecordKind::TrafficSummary,
            outcome: match self.state {
                TrafficState::Open | TrafficState::Closed => Outcome::Ok,
                TrafficState::Error => Outcome::Failed,
            },
            // 计数与状态本身不含敏感值，仍统一走脱敏保持约束一致。
            summary: redact_traffic_text(&format!(
                "{} {} {} {}B",
                self.channel_kind.as_str(),
                self.direction.as_str(),
                self.state.as_str(),
                self.bytes
            )),
            attrs,
        }
    }
}

impl ChannelKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChannelKind::Ssh => "ssh",
            ChannelKind::Acp => "acp",
            ChannelKind::Http => "http",
            ChannelKind::Tunnel => "tunnel",
        }
    }
}

impl TrafficDirection {
    pub fn as_str(&self) -> &'static str {
        match self {
            TrafficDirection::Inbound => "inbound",
            TrafficDirection::Outbound => "outbound",
        }
    }
}

impl TrafficState {
    pub fn as_str(&self) -> &'static str {
        match self {
            TrafficState::Open => "open",
            TrafficState::Closed => "closed",
            TrafficState::Error => "error",
        }
    }
}

/// 传输摘要文本脱敏：计数与状态文本本身不含凭据，此处保持与全局脱敏
/// 约束一致，防止调用方拼接额外内容时绕过约束。
fn redact_traffic_text(text: &str) -> String {
    crate::redact::redact_summary(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collector::{InMemoryCollector, ObserverCollector};
    use crate::record::Correlation;

    #[test]
    fn traffic_summary_maps_to_record() {
        let summary = TrafficSummary {
            channel_kind: ChannelKind::Ssh,
            sandbox_id: "sb-t1".to_string(),
            direction: TrafficDirection::Outbound,
            bytes: 4096,
            state: TrafficState::Closed,
        };
        let record = summary.to_record(Some("s-t1".to_string()));
        assert_eq!(record.kind, RecordKind::TrafficSummary);
        assert_eq!(record.source, RecordSource::Transport);
        assert_eq!(record.sandbox_id.as_deref(), Some("sb-t1"));
        assert_eq!(record.session_id.as_deref(), Some("s-t1"));
        assert_eq!(record.outcome, Outcome::Ok);
        assert!(record.summary.contains("ssh"));
        assert!(record.summary.contains("outbound"));
        assert!(record.summary.contains("4096"));
        // 类型上不存在 payload 字段：attrs 只含通道/方向/状态/计数。
        assert_eq!(record.attrs.len(), 5);
        assert_eq!(record.attrs["channel_kind"], serde_json::json!("ssh"));
        assert_eq!(record.attrs["bytes"], serde_json::json!(4096));
    }

    #[test]
    fn error_state_maps_to_failed() {
        let summary = TrafficSummary {
            channel_kind: ChannelKind::Tunnel,
            sandbox_id: "sb-t2".to_string(),
            direction: TrafficDirection::Inbound,
            bytes: 0,
            state: TrafficState::Error,
        };
        let record = summary.to_record(None);
        assert_eq!(record.outcome, Outcome::Failed);
    }

    #[test]
    fn no_payload_field_in_serialized_form() {
        let summary = TrafficSummary {
            channel_kind: ChannelKind::Acp,
            sandbox_id: "sb-t3".to_string(),
            direction: TrafficDirection::Inbound,
            bytes: 1,
            state: TrafficState::Open,
        };
        let json = serde_json::to_string(&summary).unwrap();
        assert!(!json.contains("payload"));
        let record = summary.to_record(None);
        let record_json = serde_json::to_string(&record).unwrap();
        assert!(!record_json.contains("payload"));
    }

    #[tokio::test]
    async fn traffic_summary_correlates_with_channel_and_sandbox() {
        let collector = InMemoryCollector::new();
        let summary = TrafficSummary {
            channel_kind: ChannelKind::Http,
            sandbox_id: "sb-t4".to_string(),
            direction: TrafficDirection::Outbound,
            bytes: 512,
            state: TrafficState::Open,
        };
        collector.collect(summary.to_record(Some("s-t4".to_string()))).await;

        let by_sandbox = collector.query(&Correlation::by_sandbox("sb-t4")).await;
        assert_eq!(by_sandbox.len(), 1);
        assert_eq!(by_sandbox[0].kind, RecordKind::TrafficSummary);
        assert_eq!(by_sandbox[0].sandbox_id.as_deref(), Some("sb-t4"));

        let by_session = collector.query(&Correlation::by_session("s-t4")).await;
        assert_eq!(by_session.len(), 1);
        assert_eq!(by_session[0].session_id.as_deref(), Some("s-t4"));
    }
}
