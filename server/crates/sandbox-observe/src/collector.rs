//! 观测采集接口：生产方通过 trait 上报，未配置实现时走空实现继续工作。
//!
//! - [`ObserverCollector`]：async 采集入口。
//! - [`NoopCollector`]：未配置采集实现时的默认选择，不做任何存储，也不
//!   报告虚假的采集成功（查询恒为空）。
//! - [`InMemoryCollector`]：测试与本地排查用，存储记录并支持按关联标识查询。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use crate::record::{Correlation, ObserveRecord};
use crate::redact;

/// 观测采集者。实现方不得阻塞调用方；记录内容必须已脱敏。
#[async_trait]
pub trait ObserverCollector: Send + Sync {
    /// 采集一条观测记录。
    async fn collect(&self, record: ObserveRecord);

    /// 按关联标识（session_id / command_ref / sandbox_id 任一命中）查询。
    async fn query(&self, correlation: &Correlation) -> Vec<ObserveRecord>;
}

/// 空采集者：未配置采集实现时生产方继续工作，不报告虚假的采集成功。
#[derive(Debug, Default)]
pub struct NoopCollector;

#[async_trait]
impl ObserverCollector for NoopCollector {
    async fn collect(&self, _record: ObserveRecord) {}

    async fn query(&self, _correlation: &Correlation) -> Vec<ObserveRecord> {
        Vec::new()
    }
}

/// 内存采集者：测试与本地排查用。存储全部记录并支持按关联标识查询。
#[derive(Debug, Default)]
pub struct InMemoryCollector {
    records: Mutex<Vec<ObserveRecord>>,
}

impl InMemoryCollector {
    pub fn new() -> Self {
        Self::default()
    }

    /// 收集至今的全部记录快照（测试断言用）。
    pub fn snapshot(&self) -> Vec<ObserveRecord> {
        self.records.lock().expect("记录锁").clone()
    }

    /// 全量扫描：返回记录全字段拼接文本，用于断言敏感值未落存储。
    pub fn dump_all_text(&self) -> String {
        let records = self.records.lock().expect("记录锁");
        records
            .iter()
            .map(|r| {
                let mut text = format!(
                    "{}|{}|{}|{}|{}|{}|{}|{:?}",
                    r.sandbox_id.as_deref().unwrap_or(""),
                    r.run_id.as_deref().unwrap_or(""),
                    r.node_id.as_deref().unwrap_or(""),
                    r.session_id.as_deref().unwrap_or(""),
                    r.command_ref.as_deref().unwrap_or(""),
                    r.summary,
                    serde_json::to_string(&r.attrs).unwrap_or_default(),
                    r.kind
                );
                // 序列化整条记录，覆盖可能藏在任何字段中的敏感值。
                text.push_str(&serde_json::to_string(r).unwrap_or_default());
                text
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[async_trait]
impl ObserverCollector for InMemoryCollector {
    async fn collect(&self, record: ObserveRecord) {
        self.records.lock().expect("记录锁").push(record);
    }

    async fn query(&self, correlation: &Correlation) -> Vec<ObserveRecord> {
        self.records
            .lock()
            .expect("记录锁")
            .iter()
            .filter(|r| r.matches_correlation(correlation))
            .cloned()
            .collect()
    }
}

/// 共享采集者句柄：生产方持有后向单一实现上报。
pub type SharedCollector = Arc<dyn ObserverCollector>;

/// 便捷构造：共享的内存采集者（测试用）。
pub fn shared_in_memory() -> Arc<InMemoryCollector> {
    Arc::new(InMemoryCollector::new())
}

/// 便捷构造：共享的空采集者。
pub fn shared_noop() -> SharedCollector {
    Arc::new(NoopCollector)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{now_ms, Outcome, RecordKind, RecordSource};

    fn record(session: &str, command: &str, kind: RecordKind) -> ObserveRecord {
        ObserveRecord {
            source: match kind {
                RecordKind::SessionEvent => RecordSource::SessionsService,
                _ => RecordSource::Channel,
            },
            sandbox_id: Some("sb-9".to_string()),
            run_id: Some("run-9".to_string()),
            node_id: None,
            session_id: Some(session.to_string()),
            command_ref: Some(command.to_string()),
            time_ms: now_ms(),
            kind,
            outcome: Outcome::Ok,
            summary: "正常摘要".to_string(),
            attrs: HashMap::new(),
        }
    }

    #[tokio::test]
    async fn same_execution_chain_queryable_by_correlation() {
        let collector = InMemoryCollector::new();
        // 同一执行链：会话事件、命令结果、进程退出共享 session_id。
        collector
            .collect(record("s-7", "c-7a", RecordKind::SessionEvent))
            .await;
        collector
            .collect(record("s-7", "c-7b", RecordKind::CommandResult))
            .await;
        collector
            .collect(record("s-7", "c-7c", RecordKind::ProcessExit))
            .await;
        // 干扰项：不同执行链。
        collector
            .collect(record("s-8", "c-8a", RecordKind::SessionEvent))
            .await;

        let found = collector
            .query(&Correlation::by_session("s-7"))
            .await;
        assert_eq!(found.len(), 3);
        let kinds: Vec<_> = found.iter().map(|r| r.kind).collect();
        assert!(kinds.contains(&RecordKind::SessionEvent));
        assert!(kinds.contains(&RecordKind::CommandResult));
        assert!(kinds.contains(&RecordKind::ProcessExit));

        assert_eq!(
            collector.query(&Correlation::by_sandbox("sb-9")).await.len(),
            4
        );
        assert_eq!(
            collector.query(&Correlation::by_command("c-7b")).await.len(),
            1
        );
    }

    #[tokio::test]
    async fn noop_collector_stays_silent() {
        let collector = NoopCollector;
        collector.collect(record("s-1", "c-1", RecordKind::CommandResult)).await;
        assert!(collector.query(&Correlation::by_session("s-1")).await.is_empty());
    }

    #[tokio::test]
    async fn stored_records_keep_no_secrets() {
        let collector = InMemoryCollector::new();
        let secret_command = "URSI_CRED_GITHUB_TOKEN=ghp_supersecret123 run-deploy";
        let record = ObserveRecord {
            summary: redact::redact_summary(&format!(
                "执行完成\n{secret_command}\npassword=hunter2hidden"
            )),
            attrs: HashMap::from([(
                "env_keys".to_string(),
                serde_json::json!(redact::redact_env(vec![
                    "URSI_CRED_GITHUB_TOKEN=ghp_supersecret123".to_string(),
                ])),
            )]),
            ..record("s-2", "c-2", RecordKind::CommandResult)
        };
        collector.collect(record).await;

        let dump = collector.dump_all_text();
        assert!(!dump.contains("ghp_supersecret123"), "原始凭据泄漏: {dump}");
        assert!(!dump.contains("hunter2hidden"), "密码泄漏: {dump}");
        assert!(dump.contains("[REDACTED]"));
    }
}
