//! 可选观测接入口。
//!
//! [`ChannelObserver`] 提供命令结果、连接状态与字节计数三类事件。观测者是
//! 可选的（`Option<Arc<dyn ChannelObserver>>`），为 `None` 时零开销路径，
//! 不影响任何连接功能。所有回调都不得包含凭据明文（密码、私钥、Bearer
//! token 一律不进入事件内容，见 [`redact`]）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// 命令执行结果事件。
#[derive(Debug, Clone)]
pub struct CommandResult {
    /// 执行的命令文本（不含环境变量等注入凭据）。
    pub command: String,
    /// 退出码。
    pub exit_code: i32,
    /// 合并输出长度（字节数，不含输出内容）。
    pub output_len: usize,
    /// 是否成功（退出码为 0）。
    pub success: bool,
}

/// 连接状态事件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    /// 连接建立完成。
    Connected,
    /// 已显式关闭。
    Closed,
    /// 连接故障（网络断开、协议中断）。
    Failed,
}

/// 字节传输计数事件。
#[derive(Debug, Clone, Copy, Default)]
pub struct ByteCounters {
    /// 累计发送字节数。
    pub tx_bytes: u64,
    /// 累计接收字节数。
    pub rx_bytes: u64,
}

/// 观测者 trait：所有回调默认空实现，消费者按需覆写。
pub trait ChannelObserver: Send + Sync {
    /// 命令执行完成。
    fn on_command_result(&self, _result: &CommandResult) {}
    /// 连接状态变化。
    fn on_connection_state(&self, _state: ConnectionState) {}
    /// 字节传输计数。
    fn on_bytes(&self, _counters: &ByteCounters) {}
}

/// 空观测者：测试与默认场景使用。
#[derive(Debug, Default)]
pub struct NoopObserver;

impl ChannelObserver for NoopObserver {}

/// 观测事件包装：`None` 时零开销，`Some` 时转发并维护累计计数。
#[derive(Clone)]
pub struct ObserverHandle {
    inner: Option<Arc<dyn ChannelObserver>>,
    tx_bytes: Arc<AtomicU64>,
    rx_bytes: Arc<AtomicU64>,
}

impl std::fmt::Debug for ObserverHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ObserverHandle")
            .field("enabled", &self.inner.is_some())
            .finish()
    }
}

impl ObserverHandle {
    /// 构造观测句柄。
    pub fn new(observer: Option<Arc<dyn ChannelObserver>>) -> Self {
        Self {
            inner: observer,
            tx_bytes: Arc::new(AtomicU64::new(0)),
            rx_bytes: Arc::new(AtomicU64::new(0)),
        }
    }

    /// 是否启用了观测消费者。
    pub fn enabled(&self) -> bool {
        self.inner.is_some()
    }

    /// 命令执行完成事件。
    pub fn command_result(&self, command: &str, exit_code: i32, output_len: usize) {
        if let Some(obs) = &self.inner {
            obs.on_command_result(&CommandResult {
                command: redact(command),
                exit_code,
                output_len,
                success: exit_code == 0,
            });
        }
    }

    /// 连接状态事件。
    pub fn connection_state(&self, state: ConnectionState) {
        if let Some(obs) = &self.inner {
            obs.on_connection_state(state);
        }
    }

    /// 累计发送 n 字节。
    pub fn bytes_tx(&self, n: usize) {
        self.tx_bytes.fetch_add(n as u64, Ordering::Relaxed);
        if let Some(obs) = &self.inner {
            obs.on_bytes(&ByteCounters {
                tx_bytes: self.tx_bytes.load(Ordering::Relaxed),
                rx_bytes: self.rx_bytes.load(Ordering::Relaxed),
            });
        }
    }

    /// 累计接收 n 字节。
    pub fn bytes_rx(&self, n: usize) {
        self.rx_bytes.fetch_add(n as u64, Ordering::Relaxed);
        if let Some(obs) = &self.inner {
            obs.on_bytes(&ByteCounters {
                tx_bytes: self.tx_bytes.load(Ordering::Relaxed),
                rx_bytes: self.rx_bytes.load(Ordering::Relaxed),
            });
        }
    }

    /// 当前累计计数快照。
    pub fn stats(&self) -> (u64, u64) {
        (
            self.tx_bytes.load(Ordering::Relaxed),
            self.rx_bytes.load(Ordering::Relaxed),
        )
    }
}

/// 脱敏：把常见凭据赋值片段替换为 `***`。
///
/// 观测事件只承载命令文本与计数，任何 `KEY=VALUE` 形式的疑似凭据、
/// `Bearer` token 与 PEM 私钥内容都被遮蔽。
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (i, line) in text.lines().enumerate() {
        let upper = line.trim_start().to_ascii_uppercase();
        // 词边界匹配：KEY=VALUE 形式的凭据词出现在行首或空格/引号之后。
        let looks_secret = upper.contains("PRIVATE KEY")
            || ["PASSWORD", "PASSWD", "TOKEN", "SECRET", "BEARER"]
            .iter()
            .any(|kw| {
                upper.match_indices(kw).any(|(pos, _)| {
                    let before_ok = pos == 0
                        || matches!(
                            upper[..pos].chars().next_back(),
                            None | Some(' ') | Some('"') | Some('\'') | Some('-')
                        );
                    let after = &upper[pos + kw.len()..];
                    before_ok
                        && (after.starts_with('=') || after.starts_with(':') || after.starts_with(' '))
                })
            });
        if i > 0 {
            out.push('\n');
        }
        if looks_secret {
            out.push_str("***");
        } else {
            out.push_str(line);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder {
        commands: Mutex<Vec<CommandResult>>,
        states: Mutex<Vec<ConnectionState>>,
        bytes: Mutex<Vec<ByteCounters>>,
    }

    impl ChannelObserver for Recorder {
        fn on_command_result(&self, r: &CommandResult) {
            self.commands.lock().unwrap().push(r.clone());
        }
        fn on_connection_state(&self, s: ConnectionState) {
            self.states.lock().unwrap().push(s);
        }
        fn on_bytes(&self, c: &ByteCounters) {
            self.bytes.lock().unwrap().push(*c);
        }
    }

    #[test]
    fn 无消费者时零开销且不影响功能() {
        let h = ObserverHandle::new(None);
        assert!(!h.enabled());
        // 不 panic 即通过。
        h.command_result("echo hi", 0, 7);
        h.connection_state(ConnectionState::Connected);
        h.bytes_tx(10);
        h.bytes_rx(20);
        assert_eq!(h.stats(), (10, 20));
    }

    #[test]
    fn 有消费者时收到全部事件() {
        let rec = Arc::new(Recorder::default());
        let h = ObserverHandle::new(Some(rec.clone()));
        h.command_result("echo hi", 0, 7);
        h.connection_state(ConnectionState::Connected);
        h.connection_state(ConnectionState::Closed);
        h.bytes_tx(1);
        h.bytes_tx(2);
        h.bytes_rx(5);

        assert_eq!(rec.commands.lock().unwrap().len(), 1);
        assert_eq!(rec.states.lock().unwrap().len(), 2);
        let counters = rec.bytes.lock().unwrap();
        assert_eq!(counters.len(), 3);
        assert_eq!(counters.last().unwrap().tx_bytes, 3);
        assert_eq!(counters.last().unwrap().rx_bytes, 5);
    }

    #[test]
    fn 观测记录不含凭据明文() {
        let rec = Arc::new(Recorder::default());
        let h = ObserverHandle::new(Some(rec.clone()));
        h.command_result(
            "echo PASSWORD=hunter2 && ssh -i id_ed25519",
            0,
            10,
        );
        let cmd = rec.commands.lock().unwrap()[0].command.clone();
        assert!(!cmd.contains("hunter2"), "密码明文泄漏：{cmd}");
    }

    #[test]
    fn 脱敏规则覆盖常见凭据形式() {
        assert_eq!(redact("TOKEN=abc"), "***");
        assert_eq!(redact("echo PASSWORD=hunter2"), "***");
        assert_eq!(redact("Bearer xyz"), "***");
        assert_eq!(redact("-----BEGIN OPENSSH PRIVATE KEY-----"), "***");
        assert_eq!(redact("echo hello"), "echo hello");
        assert_eq!(redact("a\nbTOKEN=1"), "a\nbTOKEN=1"); // 词边界内不误伤
        // 普通含字母词不误伤
        assert_eq!(redact("ls -la /tokenize"), "ls -la /tokenize");
    }
}
