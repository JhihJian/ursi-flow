//! 仅启动固定的 bwrap 与系统 Python；子进程退出、取消与输出限额都由父进程控制。
use super::{Error, invalid, unavailable};
use serde_json::Value;
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::timeout,
};

const WIRE_LIMIT: usize = 6 * 1024 * 1024;
const READY: &[u8] = b"READY\n";
pub(super) async fn run(input: &Value) -> Result<Value, Error> {
    execute("/usr/bin/bwrap", input).await
}
pub(super) async fn execute(bwrap: &str, input: &Value) -> Result<Value, Error> {
    let setup =
        || unavailable("隔离 Python 不可用，请检查 bwrap、用户命名空间、系统 Python 与 libseccomp");
    let input = serde_json::to_vec(input).map_err(|_| invalid("脚本输入无效"))?;
    if input.len() > WIRE_LIMIT {
        return Err(invalid("脚本输入超过上限"));
    }
    let mut child = Command::new(bwrap)
        .env_clear()
        .current_dir("/")
        .args([
            "--unshare-all",
            "--unshare-user",
            "--disable-userns",
            "--cap-drop",
            "ALL",
            "--die-with-parent",
            "--new-session",
            "--clearenv",
            "--ro-bind",
            "/usr/bin/python3",
            "/usr/bin/python3",
            "--ro-bind",
            "/usr/lib",
            "/usr/lib",
            "--ro-bind-try",
            "/usr/lib64",
            "/usr/lib64",
            "--symlink",
            "usr/lib",
            "/lib",
            "--symlink",
            "usr/lib64",
            "/lib64",
            "--remount-ro",
            "/",
            "--chdir",
            "/",
            "--",
            "/usr/bin/python3",
            "-I",
            "-B",
            "-S",
            "-c",
            include_str!("runner.py"),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| setup())?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    // Do not deliver untrusted data until the trusted wrapper has installed its filter.
    timeout(Duration::from_secs(6), async {
        let mut line = [0; 6];
        stdout.read_exact(&mut line).await.map_err(|_| setup())?;
        if line != READY {
            return Err(setup());
        }
        stdin
            .write_all(&input)
            .await
            .map_err(|_| invalid("脚本输入失败"))?;
        drop(stdin);
        let mut bytes = vec![];
        stdout
            .take(WIRE_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| invalid("读取脚本结果失败"))?;
        if bytes.len() > WIRE_LIMIT {
            return Err(invalid("脚本输出超过上限"));
        }
        if !child.wait().await.map_err(|_| setup())?.success() {
            return Err(invalid("Python 转换失败或超过资源限额"));
        }
        serde_json::from_slice(&bytes).map_err(|_| invalid("脚本未返回合法的 UTF-8 JSON"))
    })
    .await
    .map_err(|_| invalid("Python 转换超时"))?
}
