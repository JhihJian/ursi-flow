use super::config::Config;
use std::{fs, io, process::Stdio, time::Duration};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    time::timeout,
};

pub(super) async fn start(config: &Config) -> io::Result<Child> {
    let socket = config.home.join("runtime.sock");
    match fs::symlink_metadata(&socket) {
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                format!("{} 已存在，请确认原实例状态", socket.display()),
            ));
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e),
    }
    let mut command = Command::new(&config.flowd);
    // Runtime must not act as the Workbench that launched it, even when its
    // own token is absent. Remove deployment-only names before spawning.
    command
        .env_remove("URSI_EXECUTOR_PLATFORM_TOKEN")
        .env_remove("URSI_EXECUTOR_PLATFORM_ADMIN_TOKEN")
        .env_remove("URSI_EXECUTOR_PLATFORM_WORKBENCH_TOKEN")
        .env_remove("URSI_EXECUTOR_PLATFORM_RUNTIME_TOKEN");
    if let Some(token) = std::env::var_os("URSI_EXECUTOR_PLATFORM_RUNTIME_TOKEN") {
        if Some(&token) == std::env::var_os("URSI_EXECUTOR_PLATFORM_TOKEN").as_ref() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Runtime 和 Workbench 不能共用平台令牌",
            ));
        }
        command.env("URSI_EXECUTOR_PLATFORM_TOKEN", token);
    }
    let mut child = command
        .env("URSI_FLOW_HOME", &config.home)
        .env("URSI_FLOWD_NOTIFY", "1")
        .env_remove("URSI_API_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| io::Error::new(e.kind(), format!("无法启动 ursi-flowd: {e}")))?;
    // A private pipe proves readiness came from our child, not a racing socket owner.
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut message = [0; 9];
    if !matches!(timeout(Duration::from_secs(10), stdout.read_exact(&mut message)).await, Ok(Ok(_)) if &message == b"ready-v1\n")
    {
        child.kill().await?;
        return Err(io::Error::other(
            "ursi-flowd 未就绪，请检查 daemon 版本与数据目录",
        ));
    }
    Ok(child)
}

pub(super) async fn stop(child: &mut Child) -> io::Result<()> {
    if let Some(pid) = child.id() {
        // This Child is exclusively owned here and is not reaped until wait().
        if unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } != 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::ESRCH) {
                return Err(err);
            }
        }
    }
    let status = child.wait().await?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("ursi-flowd 退出异常: {status}")))
    }
}
