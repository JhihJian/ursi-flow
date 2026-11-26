use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

use crate::models::Connection as ConnectionConfig;
use crate::session::{batch_ssh_args, CONNECT_TIMEOUT};

/// pong 等待上限：超时说明链路已不可用，本次采样把延迟记为 null。
const LATENCY_TIMEOUT: Duration = Duration::from_secs(4);
/// 错误信息回传上限，避免把大段 ssh 输出塞进 JSON。
const ERROR_TEXT_LIMIT: usize = 400;

/// 一次远端设备资源采样。
/// CPU 用 1 分钟负载均值（/proc/loadavg 首列），内存已用由 MemTotal - MemAvailable 推出。
#[derive(Debug, Clone, serde::Serialize)]
pub struct HostMetrics {
    pub hostname: String,
    pub cores: u32,
    pub load1: f64,
    pub mem_total_kb: u64,
    pub mem_available_kb: u64,
    /// ssh 通道往返耗时（毫秒，一位小数）；未收到 pong 时为 null。
    pub latency_ms: Option<f64>,
    pub sampled_at: String,
}

/// 远端采样脚本：每行 `key value`，`end` 之后等本地写入一行换行再回 `pong`，
/// 这一问一答的耗时就是通道往返延迟，不含 ssh 握手。
/// 不加 set -e：单项缺失时整条仍要跑完，由本地判空报错。
const REMOTE_SCRIPT: &str = concat!(
    "printf 'load %s\\n' \"$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)\"; ",
    "printf 'mem %s\\n' \"$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{if (t && a) print t, a}' /proc/meminfo 2>/dev/null)\"; ",
    "printf 'cores %s\\n' \"$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)\"; ",
    "printf 'host %s\\n' \"$(hostname 2>/dev/null)\"; ",
    "printf 'end\\n'; read -r _ && printf 'pong\\n'"
);

/// 采样一台连接中的设备。服务端不缓存、不定时：每个请求就是一轮独立的批量 ssh。
pub async fn sample(connection: &ConnectionConfig) -> Result<HostMetrics> {
    tokio::time::timeout(CONNECT_TIMEOUT, sample_inner(connection))
        .await
        .map_err(|_| anyhow!("采样超时（{}s）", CONNECT_TIMEOUT.as_secs()))?
}

async fn sample_inner(connection: &ConnectionConfig) -> Result<HostMetrics> {
    let args = batch_ssh_args(&connection.command, REMOTE_SCRIPT);
    let mut child = Command::new("ssh")
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("启动 ssh 子进程失败：需要本机安装 ssh")?;
    let mut stdin = child.stdin.take().context("取 ssh stdin 失败")?;
    let stdout = child.stdout.take().context("取 ssh stdout 失败")?;
    let mut lines = BufReader::new(stdout).lines();

    let mut load = None;
    let mut mem = None;
    let mut cores = None;
    let mut hostname = None;
    let mut saw_end = false;
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                return Err(fail(&mut child, format!("读取 ssh 输出失败：{error}")).await);
            }
        };
        if line == "end" {
            saw_end = true;
            break;
        }
        let Some((key, value)) = line.split_once(' ') else {
            continue;
        };
        match key {
            "load" => load = value.trim().parse::<f64>().ok(),
            "mem" => {
                let mut parts = value.split_whitespace();
                let total = parts.next().and_then(|v| v.parse::<u64>().ok());
                let available = parts.next().and_then(|v| v.parse::<u64>().ok());
                if let (Some(total), Some(available)) = (total, available) {
                    mem = Some((total, available));
                }
            }
            "cores" => cores = value.trim().parse::<u32>().ok(),
            "host" => hostname = Some(value.trim().to_string()),
            _ => {}
        }
    }
    if !saw_end {
        return Err(fail(&mut child, "ssh 未输出采样结果".to_string()).await);
    }

    // 通道往返：写一行换行唤醒远端 read，量到 pong 的时间。
    let started = Instant::now();
    let latency = match stdin.write_all(b"\n").await {
        Ok(()) => match tokio::time::timeout(LATENCY_TIMEOUT, lines.next_line()).await {
            Ok(Ok(Some(line))) if line == "pong" => Some(started.elapsed().as_secs_f64() * 1000.0),
            _ => None,
        },
        Err(_) => None,
    };

    // 关掉 stdin 让远端脚本结束，收掉子进程；超时由 kill_on_drop 兜底。
    drop(stdin);
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;

    let load1 = load.ok_or_else(|| anyhow!("远端不是 Linux 或 /proc/loadavg 不可读"))?;
    let (mem_total_kb, mem_available_kb) =
        mem.ok_or_else(|| anyhow!("远端 /proc/meminfo 缺少 MemTotal 或 MemAvailable"))?;
    let cores = cores.filter(|cores| *cores > 0).unwrap_or(1);
    let hostname = hostname.filter(|name| !name.is_empty()).unwrap_or_default();

    Ok(HostMetrics {
        hostname,
        cores,
        load1,
        mem_total_kb,
        mem_available_kb,
        latency_ms: latency.map(|ms| (ms * 10.0).round() / 10.0),
        sampled_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })
}

/// 采样失败：终止子进程，并把 ssh 自己的 stderr 附在消息里（认证、不可达等都在那里）。
async fn fail(child: &mut Child, message: String) -> anyhow::Error {
    let _ = child.kill().await;
    let mut stderr_text = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut stderr_text).await;
    }
    let detail = stderr_text.trim();
    if detail.is_empty() {
        anyhow!("{message}（ssh 无错误输出）")
    } else {
        let clipped: String = detail.chars().take(ERROR_TEXT_LIMIT).collect();
        anyhow!("{message}：{clipped}")
    }
}
