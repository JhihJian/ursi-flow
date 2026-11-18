//! 每会话独立 subreaper。Pi 的 bash 可以 setsid，因此不能仅 killpg(Pi)。
use super::SpawnSpec;
use std::{
    collections::HashSet,
    os::unix::process::CommandExt,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

static STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
}

/// 在构建 Tokio runtime 之前调用。只接受由本服务生成的启动参数。
pub fn run(spec: SpawnSpec, expected_parent: u32, lock_fd: i32, receipt_fd: i32) -> i32 {
    unsafe {
        libc::signal(libc::SIGTERM, stop as *const () as usize);
        libc::signal(libc::SIGINT, stop as *const () as usize);
        let mut mask = std::mem::zeroed();
        libc::sigemptyset(&mut mask);
        libc::sigaddset(&mut mask, libc::SIGTERM);
        if libc::sigprocmask(libc::SIG_UNBLOCK, &mask, std::ptr::null_mut()) != 0 {
            return 1;
        }
        if libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1) != 0
            || libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0
        {
            return 1;
        }
        if libc::getppid() as u32 != expected_parent {
            return 1;
        }
    }
    // 清理依赖 pidfd，不在旧内核上静默降级为可能误杀的裸 PID 信号。
    let probe = unsafe { libc::syscall(libc::SYS_pidfd_open, std::process::id(), 0) as i32 };
    if probe < 0 {
        return 1;
    }
    unsafe {
        libc::close(probe);
    }
    let supervisor_pid = std::process::id();
    let mut cmd = Command::new(&spec.bin);
    cmd.args([
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-context-files",
        "--no-approve",
        "--no-prompt-templates",
        "--no-themes",
        "--offline",
    ])
    .args(["--provider", &spec.provider, "--model", &spec.model])
    .env_clear()
    .env("PATH", "/usr/local/bin:/usr/bin:/bin")
    .env("HOME", &spec.runtime_dir)
    .env("TMPDIR", &spec.runtime_dir)
    .env("PI_CODING_AGENT_DIR", spec.runtime_dir.join("pi"))
    .env("PI_OFFLINE", "1")
    .env("PI_SKIP_VERSION_CHECK", "1")
    .env("PI_TELEMETRY", "0")
    .env("LANG", "C.UTF-8")
    .stdin(Stdio::inherit())
    .stdout(Stdio::inherit())
    .stderr(Stdio::null());
    unsafe {
        cmd.pre_exec(move || {
            libc::close(receipt_fd);
            if lock_fd >= 0 {
                libc::close(lock_fd);
            }
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::geteuid() == 0
                && (libc::setgroups(0, std::ptr::null()) != 0
                    || libc::setgid(1000) != 0
                    || libc::setuid(1000) != 0)
            {
                return Err(std::io::Error::last_os_error());
            }
            // setuid 会清除 PDEATHSIG，所以必须在降权后设置。
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0
                || libc::getppid() as u32 != supervisor_pid
                || libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(_) => return 1,
    };
    let code = loop {
        if STOP.load(Ordering::SeqCst) {
            break 0;
        }
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(1),
            Err(_) => break 1,
            _ => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    cleanup();
    // 专用 fd 不传给 Pi，只有 ECHILD 后才写回执。服务仍须核对退出状态。
    let sent = unsafe { libc::write(receipt_fd, [1u8].as_ptr().cast(), 1) };
    unsafe {
        libc::close(receipt_fd);
    }
    if sent == 1 { code } else { 1 }
}

/// 返回此 supervisor 的全部后代，不接触其他会话。/proc stat 的 comm 可包含空格与括号。
fn descendants() -> Vec<(i32, u64)> {
    let mut table = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|s| s.parse::<i32>().ok())
            else {
                continue;
            };
            if let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) {
                if let Some(rest) = stat.rsplit_once(") ").map(|(_, rest)| rest) {
                    let fields: Vec<_> = rest.split_whitespace().collect();
                    if let (Some(ppid), Some(start)) = (
                        fields.get(1).and_then(|s| s.parse::<i32>().ok()),
                        fields.get(19).and_then(|s| s.parse::<u64>().ok()),
                    ) {
                        table.push((pid, ppid, start));
                    }
                }
            }
        }
    }
    let mut known = HashSet::from([std::process::id() as i32]);
    let mut ordered = Vec::new();
    loop {
        let mut added = false;
        for &(pid, ppid, start) in &table {
            if known.contains(&ppid) && known.insert(pid) {
                ordered.push((pid, start));
                added = true;
            }
        }
        if !added {
            break;
        }
    }
    ordered
}

fn signal((pid, start): (i32, u64), signal: i32) {
    unsafe {
        // pidfd 避免扫描后 PID 复用时向另一个进程发信号。
        let fd = libc::syscall(libc::SYS_pidfd_open, pid, 0) as i32;
        if fd >= 0 {
            let identity = std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|stat| {
                    stat.rsplit_once(") ")
                        .and_then(|(_, rest)| rest.split_whitespace().nth(19))
                        .and_then(|s| s.parse::<u64>().ok())
                });
            if identity == Some(start) {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd,
                    signal,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                );
            }
            libc::close(fd);
        }
    }
}

fn cleanup() {
    loop {
        // 先冻结祖先再扫描新生后代。后代停止后才杀父进程，保留归属关系。
        let first = descendants();
        for &pid in &first {
            signal(pid, libc::SIGSTOP);
        }
        let second = descendants();
        for &pid in &second {
            signal(pid, libc::SIGSTOP);
        }
        for &pid in second.iter().rev() {
            signal(pid, libc::SIGKILL);
        }
        loop {
            let result = unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) };
            if result > 0 {
                continue;
            }
            if result < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD) {
                return;
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
