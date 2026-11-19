use super::Outcome;
use std::{io, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
};

const LIMIT: usize = 64 * 1024;
pub(super) const DEADLINE: Duration = Duration::from_secs(300);

fn command(bin: &Path, workspace: &Path, artifact: &Path, config: Option<&Path>) -> Command {
    let mut cmd = Command::new(bin);
    cmd.current_dir(workspace)
        .args([
            "--print",
            "--mode",
            "text",
            "--no-session",
            "--no-tools",
            "--no-extensions",
            "--no-mcp",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--no-approve",
        ])
        .env_clear()
        .env("URSI_ARTIFACT_DIR", artifact)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    if let Some(config) = config {
        cmd.env("URSI_CONFIG_DIR", config);
    }
    for name in [
        "PATH",
        "HOME",
        "LANG",
        "PI_CODING_AGENT_DIR",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
    ] {
        if let Some(val) = std::env::var_os(name) {
            cmd.env(name, val);
        }
    }
    cmd
}

struct Group(Option<i32>);
impl Group {
    fn stop(&mut self) -> io::Result<()> {
        if let Some(pgid) = self.0 {
            // A fresh group is created by Command before exec. Never signal a saved PID after restart.
            if unsafe { libc::kill(-pgid, libc::SIGKILL) } != 0 {
                let err = io::Error::last_os_error();
                if err.raw_os_error() != Some(libc::ESRCH) {
                    return Err(err);
                }
            }
            self.0 = None;
        }
        Ok(())
    }
}
impl Drop for Group {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

async fn capture(pipe: impl AsyncRead + Unpin) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    pipe.take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > LIMIT {
        return Err(io::Error::other("Agent 输出超过 64 KiB"));
    }
    Ok(bytes)
}

pub(super) async fn run(
    bin: &Path,
    workspace: &Path,
    artifact: &Path,
    prompt: String,
    config: Option<&Path>,
    cancel: &mut watch::Receiver<bool>,
    deadline: Duration,
) -> Outcome {
    if *cancel.borrow() {
        return Outcome::new("cancelled", "执行前已取消");
    }
    let mut child = match command(bin, workspace, artifact, config).spawn() {
        Ok(child) => child,
        Err(e) => return Outcome::new("failed", format!("Agent 未能启动: {e}")),
    };
    let mut group = Group(Some(child.id().expect("newly spawned child") as i32));
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let result = tokio::select! {
        signal = cancel.changed() => match signal {
            Ok(()) if *cancel.borrow() => Outcome::new("cancelled", "已取消"),
            _ => Outcome::new("unverified", "Agent 控制连接已断开，未确认结果；不会重发"),
        },
        _ = tokio::time::sleep(deadline) => Outcome::new("failed", "Agent 执行超时"),
        result = async {
            tokio::try_join!(
                async move { stdin.write_all(prompt.as_bytes()).await?; stdin.shutdown().await },
                capture(stdout), capture(stderr),
                async { let code = child.wait().await?; group.stop()?; Ok(code) },
            )
        } => match result {
            Ok(((), out, _, status)) if status.success() => {
                // 标准输出是执行器自己的记录，同时保留为旧 output 字段。
                let text = String::from_utf8_lossy(&out).into_owned();
                Outcome::logged("succeeded", text.clone(), "agent", text)
            }
            Ok(((), _, _, status)) => Outcome::new("failed", format!("Agent 退出: {status}")),
            Err(e) => Outcome::new("failed", format!("Agent I/O: {e}")),
        }
    };
    if group.stop().is_err()
        || !matches!(
            tokio::time::timeout(Duration::from_secs(3), child.wait()).await,
            Ok(Ok(_))
        )
    {
        return Outcome::new("unverified", "无法确认 Agent 已退出");
    }
    result
}
