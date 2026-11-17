//! 文件与命令通道网关替身：记录目标身份与请求参数，支持故障注入。

use std::collections::HashMap;
use std::sync::Mutex;

use crate::sandboxes::traits::channel::{
    ChannelAccessError, ChannelGateway, ChannelTarget, CommandOutcome, TerminalHandle,
};

/// 文件通道调用记录：(目标身份, 路径, 内容)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileCall {
    pub target: ChannelTarget,
    pub path: String,
    pub bytes: Vec<u8>,
}

/// 命令通道调用记录：(目标身份, 命令)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecCall {
    pub target: ChannelTarget,
    pub cmd: String,
}

/// 终端通道调用记录：目标身份。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalCall {
    pub target: ChannelTarget,
}

/// 通道故障注入。
#[derive(Debug, Clone, Default)]
pub(crate) struct ChannelFailures {
    /// 文件通道连接中断。
    pub file_connection: bool,
    /// 命令通道端点不可达。
    pub exec_unreachable: bool,
    /// 终端通道鉴权失败。
    pub terminal_auth: bool,
    /// 通道已回收（Closed）。
    pub closed: bool,
}

/// 回收的终端句柄替身：建立即可用，close 后 is_open 返回 false。
pub(crate) struct FakeTerminal {
    open: bool,
}

impl Default for FakeTerminal {
    fn default() -> Self {
        Self { open: true }
    }
}

impl std::fmt::Debug for FakeTerminal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeTerminal").field("open", &self.open).finish()
    }
}

impl TerminalHandle for FakeTerminal {
    fn close(&mut self) {
        self.open = false;
    }
    fn is_open(&self) -> bool {
        self.open
    }
}

struct Inner {
    files: Vec<FileCall>,
    execs: Vec<ExecCall>,
    terminals: Vec<TerminalCall>,
    /// 回读缓冲：path -> bytes（验收回读完整性）。
    stored: HashMap<String, Vec<u8>>,
    /// 已回收句柄数（释放与关闭时 close_sandbox 回收）。
    recycled: usize,
}

/// 可记录、可注入故障的通道网关替身。
pub(crate) struct FakeChannels {
    inner: Mutex<Inner>,
    failures: Mutex<ChannelFailures>,
}

impl FakeChannels {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                files: Vec::new(),
                execs: Vec::new(),
                terminals: Vec::new(),
                stored: HashMap::new(),
                recycled: 0,
            }),
            failures: Mutex::new(ChannelFailures::default()),
        }
    }

    /// 注入故障组合。
    pub(crate) fn fail(&self, failures: ChannelFailures) {
        *self.failures.lock().unwrap() = failures;
    }

    /// 文件通道调用记录快照。
    pub(crate) fn file_calls(&self) -> Vec<FileCall> {
        self.inner.lock().unwrap().files.clone()
    }

    /// 命令通道调用记录快照。
    pub(crate) fn exec_calls(&self) -> Vec<ExecCall> {
        self.inner.lock().unwrap().execs.clone()
    }

    /// 终端通道调用记录快照。
    #[allow(dead_code)]
    pub(crate) fn terminal_calls(&self) -> Vec<TerminalCall> {
        self.inner.lock().unwrap().terminals.clone()
    }

    /// 已回收句柄数。
    pub(crate) fn recycled(&self) -> usize {
        self.inner.lock().unwrap().recycled
    }
}

#[async_trait::async_trait]
impl ChannelGateway for FakeChannels {
    async fn open_file_channel(
        &self,
        target: &ChannelTarget,
        path: &str,
        bytes: &[u8],
    ) -> Result<usize, ChannelAccessError> {
        let failures = self.failures.lock().unwrap().clone();
        if failures.closed {
            return Err(ChannelAccessError::Closed("通道已回收".into()));
        }
        let mut inner = self.inner.lock().unwrap();
        inner
            .files
            .push(FileCall { target: target.clone(), path: path.into(), bytes: bytes.to_vec() });
        if failures.file_connection {
            // 先记录调用参数再中断：验收「目标身份正确 + 连接故障可区分」。
            return Err(ChannelAccessError::Connection("模拟连接中断".into()));
        }
        inner.stored.insert(path.to_string(), bytes.to_vec());
        Ok(bytes.len())
    }

    async fn open_exec_channel(
        &self,
        target: &ChannelTarget,
        cmd: &str,
    ) -> Result<CommandOutcome, ChannelAccessError> {
        let failures = self.failures.lock().unwrap().clone();
        if failures.exec_unreachable {
            return Err(ChannelAccessError::Unreachable("模拟端点不可达".into()));
        }
        self.inner.lock().unwrap().execs.push(ExecCall { target: target.clone(), cmd: cmd.into() });
        Ok(CommandOutcome { output: format!("ran: {cmd}"), exit_code: 0 })
    }

    async fn open_terminal(
        &self,
        target: &ChannelTarget,
    ) -> Result<Box<dyn TerminalHandle>, ChannelAccessError> {
        let failures = self.failures.lock().unwrap().clone();
        if failures.terminal_auth {
            return Err(ChannelAccessError::Auth("模拟端点鉴权失败".into()));
        }
        self.inner.lock().unwrap().terminals.push(TerminalCall { target: target.clone() });
        Ok(Box::new(FakeTerminal::default()))
    }

    async fn close_sandbox(&self, _sandbox_id: &str) {
        self.inner.lock().unwrap().recycled += 1;
    }
}
