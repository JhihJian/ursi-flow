//! 生产方集成契约：把 channel 与 agent-runtime 已有事件形态映射为
//! [`ObserveRecord`] 的适配签名。
//!
//! 这些 trait 只定义「事件参数 → 记录」的构造边界，具体挂接由 app 装配
//! 时完成：app 把实现了 [`crate::collector::ObserverCollector`] 的采集者
//! 注入 channel / agent-runtime 的可选观测槽位，各生产方调用本模块的
//! adapter 把自身事件转成记录后 `collect`。channel 与 agent-runtime 的
//! 类型不出现在本 crate 依赖中，双方仅通过本 crate 的记录类型解耦。
//!
//! 主机侧执行命令时由实际执行方上报（source 与上报方一致），不能以沙箱
//! SSH 命令记录冒充主机审计。

use std::collections::HashMap;

use crate::record::{now_ms, ObserveRecord, Outcome, RecordKind, RecordSource};
use crate::redact;

/// 适配器：把生产方已有事件映射为观测记录。
pub trait RecordAdapter {
    /// 产出的记录来源。
    fn source(&self) -> RecordSource;
}

/// Channel 命令结果事件（对应 channel 观测的命令回调形态）。
#[derive(Debug, Clone)]
pub struct ChannelCommandEvent<'a> {
    pub command: &'a str,
    pub exit_code: i32,
    pub output_len: usize,
    pub sandbox_id: &'a str,
    pub session_id: &'a str,
    pub command_ref: &'a str,
}

/// Channel 连接状态事件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelConnectionState {
    Connected,
    Closed,
    Failed,
}

/// Channel 观测适配：命令结果与连接状态 → 记录。
pub trait ChannelObserverAdapter {
    /// 命令执行结果事件转记录。命令文本与输出长度经脱敏后进入 summary，
    /// 输出内容本身不进入记录。
    fn on_command_result(&self, event: ChannelCommandEvent<'_>) -> ObserveRecord;

    /// 连接状态事件转记录。
    fn on_connection_state(
        &self,
        state: ChannelConnectionState,
        sandbox_id: &str,
        session_id: Option<&str>,
    ) -> ObserveRecord;
}

/// agent 会话事件（对应 agent-runtime / session-service 会话事件形态）。
#[derive(Debug, Clone)]
pub struct SessionEventPayload<'a> {
    pub name: &'a str,
    pub phase: &'a str,
    pub message: &'a str,
    pub sandbox_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub node_id: Option<&'a str>,
    pub session_id: &'a str,
}

/// 会话事件适配：agent 会话事件 → 记录。
pub trait SessionEventAdapter {
    fn on_session_event(&self, event: SessionEventPayload<'_>) -> ObserveRecord;
}

/// 监督器进程退出事件。
#[derive(Debug, Clone)]
pub struct ProcessExitEvent<'a> {
    pub sandbox_id: &'a str,
    pub node_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub exit_code: i32,
    pub signal: Option<&'a str>,
}

/// 监督器适配：进程退出 → 记录。
pub trait SupervisorObserverAdapter {
    fn on_process_exit(&self, event: ProcessExitEvent<'_>) -> ObserveRecord;
}

/// 默认适配实现：所有 adapter 共享同一构造逻辑，输出统一走脱敏助手。
pub struct DefaultAdapter {
    source: RecordSource,
}

impl DefaultAdapter {
    pub fn new(source: RecordSource) -> Self {
        Self { source }
    }
}

impl RecordAdapter for DefaultAdapter {
    fn source(&self) -> RecordSource {
        self.source
    }
}

impl ChannelObserverAdapter for DefaultAdapter {
    fn on_command_result(&self, event: ChannelCommandEvent<'_>) -> ObserveRecord {
        let outcome = if event.exit_code == 0 {
            Outcome::Ok
        } else {
            Outcome::Failed
        };
        let summary = redact::redact_summary(&format!(
            "命令退出码 {}，输出 {} 字节：{}",
            event.exit_code, event.output_len,
            redact::redact_summary(event.command)
        ));
        ObserveRecord {
            source: RecordSource::Channel,
            sandbox_id: Some(event.sandbox_id.to_string()),
            run_id: None,
            node_id: None,
            session_id: Some(event.session_id.to_string()),
            command_ref: Some(event.command_ref.to_string()),
            time_ms: now_ms(),
            kind: RecordKind::CommandResult,
            outcome,
            summary,
            attrs: HashMap::from([
                ("exit_code".to_string(), serde_json::json!(event.exit_code)),
                ("output_len".to_string(), serde_json::json!(event.output_len)),
            ]),
        }
    }

    fn on_connection_state(
        &self,
        state: ChannelConnectionState,
        sandbox_id: &str,
        session_id: Option<&str>,
    ) -> ObserveRecord {
        let outcome = match state {
            ChannelConnectionState::Connected | ChannelConnectionState::Closed => Outcome::Ok,
            ChannelConnectionState::Failed => Outcome::Failed,
        };
        ObserveRecord {
            source: RecordSource::Channel,
            sandbox_id: Some(sandbox_id.to_string()),
            run_id: None,
            node_id: None,
            session_id: session_id.map(str::to_string),
            command_ref: None,
            time_ms: now_ms(),
            kind: RecordKind::ConnectionState,
            outcome,
            summary: redact::redact_summary(&format!("连接状态 {:?}", state)),
            attrs: HashMap::from([(
                "state".to_string(),
                serde_json::json!(match state {
                    ChannelConnectionState::Connected => "connected",
                    ChannelConnectionState::Closed => "closed",
                    ChannelConnectionState::Failed => "failed",
                }),
            )]),
        }
    }
}

impl SessionEventAdapter for DefaultAdapter {
    fn on_session_event(&self, event: SessionEventPayload<'_>) -> ObserveRecord {
        ObserveRecord {
            source: self.source(),
            sandbox_id: event.sandbox_id.map(str::to_string),
            run_id: event.run_id.map(str::to_string),
            node_id: event.node_id.map(str::to_string),
            session_id: Some(event.session_id.to_string()),
            command_ref: None,
            time_ms: now_ms(),
            kind: RecordKind::SessionEvent,
            outcome: Outcome::Ok,
            summary: redact::redact_summary(event.message),
            attrs: HashMap::from([
                ("name".to_string(), serde_json::json!(event.name)),
                ("phase".to_string(), serde_json::json!(event.phase)),
            ]),
        }
    }
}

impl SupervisorObserverAdapter for DefaultAdapter {
    fn on_process_exit(&self, event: ProcessExitEvent<'_>) -> ObserveRecord {
        let outcome = if event.exit_code == 0 {
            Outcome::Ok
        } else {
            Outcome::Failed
        };
        let mut attrs = HashMap::from([(
            "exit_code".to_string(),
            serde_json::json!(event.exit_code),
        )]);
        if let Some(signal) = event.signal {
            attrs.insert("signal".to_string(), serde_json::json!(signal));
        }
        ObserveRecord {
            source: RecordSource::Supervisor,
            sandbox_id: Some(event.sandbox_id.to_string()),
            run_id: None,
            node_id: event.node_id.map(str::to_string),
            session_id: event.session_id.map(str::to_string),
            command_ref: None,
            time_ms: now_ms(),
            kind: RecordKind::ProcessExit,
            outcome,
            summary: redact::redact_summary(&format!(
                "进程退出 {}{}",
                event.exit_code,
                event.signal.map(|s| format!("（信号 {s}）")).unwrap_or_default()
            )),
            attrs,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collector::{InMemoryCollector, ObserverCollector};
    use crate::record::Correlation;

    #[test]
    fn command_result_adapter_redacts_and_correlates() {
        let adapter = DefaultAdapter::new(RecordSource::Channel);
        let record = adapter.on_command_result(ChannelCommandEvent {
            command: "URSI_CRED_GITHUB_TOKEN=ghp_tok123 deploy",
            exit_code: 0,
            output_len: 128,
            sandbox_id: "sb-h1",
            session_id: "s-h1",
            command_ref: "c-h1",
        });
        assert_eq!(record.source, RecordSource::Channel);
        assert_eq!(record.kind, RecordKind::CommandResult);
        assert_eq!(record.outcome, Outcome::Ok);
        assert!(!record.summary.contains("ghp_tok123"));
        assert!(record.summary.contains("[REDACTED]"));
        assert_eq!(record.sandbox_id.as_deref(), Some("sb-h1"));
        assert_eq!(record.session_id.as_deref(), Some("s-h1"));
        assert_eq!(record.command_ref.as_deref(), Some("c-h1"));
        assert_eq!(record.attrs["exit_code"], serde_json::json!(0));
    }

    #[test]
    fn command_failure_maps_to_failed() {
        let adapter = DefaultAdapter::new(RecordSource::Channel);
        let record = adapter.on_command_result(ChannelCommandEvent {
            command: "false",
            exit_code: 2,
            output_len: 0,
            sandbox_id: "sb-h1",
            session_id: "s-h1",
            command_ref: "c-h2",
        });
        assert_eq!(record.outcome, Outcome::Failed);
    }

    #[test]
    fn connection_state_adapter_maps_outcome() {
        let adapter = DefaultAdapter::new(RecordSource::Channel);
        let connected = adapter.on_connection_state(ChannelConnectionState::Connected, "sb-h2", Some("s-h2"));
        assert_eq!(connected.kind, RecordKind::ConnectionState);
        assert_eq!(connected.outcome, Outcome::Ok);
        assert_eq!(connected.session_id.as_deref(), Some("s-h2"));
        let failed = adapter.on_connection_state(ChannelConnectionState::Failed, "sb-h2", None);
        assert_eq!(failed.outcome, Outcome::Failed);
        assert!(failed.session_id.is_none());
    }

    #[test]
    fn session_event_adapter_keeps_correlation_and_redacts_message() {
        let adapter = DefaultAdapter::new(RecordSource::SessionsService);
        let record = adapter.on_session_event(SessionEventPayload {
            name: "tool.call",
            phase: "finish",
            message: "prompt 完成 password=zzz9secret",
            sandbox_id: Some("sb-h3"),
            run_id: Some("run-h3"),
            node_id: Some("node-h3"),
            session_id: "s-h3",
        });
        assert_eq!(record.source, RecordSource::SessionsService);
        assert_eq!(record.kind, RecordKind::SessionEvent);
        assert!(!record.summary.contains("zzz9secret"));
        assert_eq!(record.run_id.as_deref(), Some("run-h3"));
        assert_eq!(record.node_id.as_deref(), Some("node-h3"));
        assert_eq!(record.attrs["name"], serde_json::json!("tool.call"));
    }

    #[test]
    fn process_exit_adapter_records_signal() {
        let adapter = DefaultAdapter::new(RecordSource::Supervisor);
        let record = adapter.on_process_exit(ProcessExitEvent {
            sandbox_id: "sb-h4",
            node_id: Some("node-h4"),
            session_id: Some("s-h4"),
            exit_code: -1,
            signal: Some("SIGKILL"),
        });
        assert_eq!(record.source, RecordSource::Supervisor);
        assert_eq!(record.kind, RecordKind::ProcessExit);
        assert_eq!(record.outcome, Outcome::Failed);
        assert_eq!(record.attrs["signal"], serde_json::json!("SIGKILL"));
        assert_eq!(record.node_id.as_deref(), Some("node-h4"));
    }

    #[tokio::test]
    async fn adapted_chain_is_queryable_by_session() {
        let collector = InMemoryCollector::new();
        let channel_adapter = DefaultAdapter::new(RecordSource::Channel);
        let session_adapter = DefaultAdapter::new(RecordSource::SessionsService);
        let supervisor_adapter = DefaultAdapter::new(RecordSource::Supervisor);

        collector
            .collect(session_adapter.on_session_event(SessionEventPayload {
                name: "session.start",
                phase: "start",
                message: "会话开始",
                sandbox_id: Some("sb-h5"),
                run_id: Some("run-h5"),
                node_id: None,
                session_id: "s-h5",
            }))
            .await;
        collector
            .collect(channel_adapter.on_command_result(ChannelCommandEvent {
                command: "ls -la",
                exit_code: 0,
                output_len: 64,
                sandbox_id: "sb-h5",
                session_id: "s-h5",
                command_ref: "c-h5",
            }))
            .await;
        collector
            .collect(supervisor_adapter.on_process_exit(ProcessExitEvent {
                sandbox_id: "sb-h5",
                node_id: Some("node-h5"),
                session_id: Some("s-h5"),
                exit_code: 0,
                signal: None,
            }))
            .await;

        let found = collector.query(&Correlation::by_session("s-h5")).await;
        assert_eq!(found.len(), 3);
        let dump = collector.dump_all_text();
        assert!(!dump.contains("ghp_"));
    }
}
