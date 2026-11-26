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

/// 一条进程的内存占用（按 RSS 排序取前几）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProcessUsage {
    pub pid: u32,
    pub name: String,
    /// ps 给出的物理内存占比（%）。
    pub mem_percent: f64,
    pub rss_kb: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiskUsage {
    pub total_kb: u64,
    pub used_kb: u64,
}

/// 一次远端设备资源采样。
/// CPU 使用率由同一轮里两次 `/proc/stat` 的差值算出；内存已用 = MemTotal - MemAvailable。
#[derive(Debug, Clone, serde::Serialize)]
pub struct HostMetrics {
    pub hostname: String,
    pub cores: u32,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    /// 两次 /proc/stat 间隔内的忙碌占比（%）；取不到内核计数时为 null。
    pub cpu_percent: Option<f64>,
    pub mem_total_kb: u64,
    pub mem_available_kb: u64,
    pub mem_free_kb: u64,
    pub swap_total_kb: u64,
    pub swap_free_kb: u64,
    /// 根分区用量；df 不可用时为 null。
    pub disk: Option<DiskUsage>,
    pub uptime_secs: Option<u64>,
    /// 所有非 lo 网卡的累计字节数，速率由调用方按两次采样的差值计算。
    pub net_rx_bytes: u64,
    pub net_tx_bytes: u64,
    /// ssh 通道往返耗时（毫秒，一位小数）；未收到 pong 时为 null。
    pub latency_ms: Option<f64>,
    pub processes: Vec<ProcessUsage>,
    pub sampled_at: String,
}

/// 远端采样脚本：先读两次 /proc/stat（间隔 0.25s）算 CPU 使用率，
/// 再逐行输出 `key value`，`procmem` 之后是 ps 表，最后 `end` 等本地写一行换行再回 `pong`。
/// 这一问一答的耗时就是通道往返延迟，不含 ssh 握手。
/// 不加 set -e：单项缺失时整条仍要跑完，由本地判空降级。
const REMOTE_SCRIPT: &str = r#"
IFS= read -r stat1 < /proc/stat; printf 'stat1 %s\n' "$stat1"
sleep 0.25
IFS= read -r stat2 < /proc/stat; printf 'stat2 %s\n' "$stat2"
printf 'load %s\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
printf 'mem %s\n' "$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} /^MemFree:/{f=$2} /^SwapTotal:/{st=$2} /^SwapFree:/{sf=$2} END{if (t && a) print t, a, f, st, sf}' /proc/meminfo 2>/dev/null)"
printf 'disk %s\n' "$(df -kP / 2>/dev/null | awk 'NR==2{print $2, $3}')"
read -r up _ < /proc/uptime; printf 'uptime %s\n' "$up"
printf 'net %s\n' "$(awk 'NR>2 { gsub(/^[ \t]+/, ""); split($0, p, ":"); if (p[1] != "lo") { split(p[2], v, " "); rx += v[1]; tx += v[9] } } END { print rx + 0, tx + 0 }' /proc/net/dev 2>/dev/null)"
printf 'cores %s\n' "$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
printf 'host %s\n' "$(hostname 2>/dev/null)"
printf 'procmem\n'
ps -eo pid=,pmem=,rss=,comm= --sort=-rss 2>/dev/null | head -n 5
printf 'end\n'
read -r _ && printf 'pong\n'
"#;

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

    let mut stat_first = None;
    let mut stat_second = None;
    let mut load = None;
    let mut mem = None;
    let mut disk = None;
    let mut uptime = None;
    let mut net = None;
    let mut cores = None;
    let mut hostname = None;
    let mut processes = Vec::new();
    let mut in_processes = false;
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
        if line == "procmem" {
            in_processes = true;
            continue;
        }
        if in_processes {
            if let Some(process) = parse_process(&line) {
                processes.push(process);
            }
            continue;
        }
        let Some((key, value)) = line.split_once(' ') else {
            continue;
        };
        match key {
            "stat1" => stat_first = Some(parse_cpu_stat(value)),
            "stat2" => stat_second = Some(parse_cpu_stat(value)),
            "load" => load = parse_load(value),
            "mem" => mem = parse_mem(value),
            "disk" => disk = parse_disk(value),
            "uptime" => uptime = value.trim().parse::<f64>().ok().map(|secs| secs as u64),
            "net" => net = parse_net(value),
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

    let (load1, load5, load15) =
        load.ok_or_else(|| anyhow!("远端不是 Linux 或 /proc/loadavg 不可读"))?;
    let (mem_total_kb, mem_available_kb, mem_free_kb, swap_total_kb, swap_free_kb) =
        mem.ok_or_else(|| anyhow!("远端 /proc/meminfo 缺少 MemTotal 或 MemAvailable"))?;
    let (net_rx_bytes, net_tx_bytes) = net.unwrap_or((0, 0));
    let cores = cores.filter(|cores| *cores > 0).unwrap_or(1);
    let hostname = hostname.filter(|name| !name.is_empty()).unwrap_or_default();

    Ok(HostMetrics {
        hostname,
        cores,
        load1,
        load5,
        load15,
        cpu_percent: cpu_busy_percent(stat_first.as_deref(), stat_second.as_deref()),
        mem_total_kb,
        mem_available_kb,
        mem_free_kb,
        swap_total_kb,
        swap_free_kb,
        disk,
        uptime_secs: uptime,
        net_rx_bytes,
        net_tx_bytes,
        latency_ms: latency.map(|ms| (ms * 10.0).round() / 10.0),
        processes,
        sampled_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })
}

/// `/proc/stat` 首行去掉 `cpu` 后取前 8 个计数（user..steal），guest 已含在 user/nice 里。
fn parse_cpu_stat(line: &str) -> Vec<u64> {
    line.split_whitespace()
        .skip(1)
        .filter_map(|value| value.parse::<u64>().ok())
        .take(8)
        .collect()
}

fn cpu_busy_percent(first: Option<&[u64]>, second: Option<&[u64]>) -> Option<f64> {
    let (first, second) = (first?, second?);
    if first.len() < 5 || first.len() != second.len() {
        return None;
    }
    let total = |values: &[u64]| values.iter().sum::<u64>();
    let total_delta = total(second).checked_sub(total(first))?;
    let idle_delta = (second[3] + second[4]).checked_sub(first[3] + first[4])?;
    if total_delta == 0 {
        return None;
    }
    Some((total_delta - idle_delta) as f64 / total_delta as f64 * 100.0)
}

fn parse_load(value: &str) -> Option<(f64, f64, f64)> {
    let mut parts = value.split_whitespace();
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

fn parse_mem(value: &str) -> Option<(u64, u64, u64, u64, u64)> {
    let mut parts = value.split_whitespace();
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

fn parse_disk(value: &str) -> Option<DiskUsage> {
    let mut parts = value.split_whitespace();
    let total_kb = parts.next()?.parse().ok()?;
    let used_kb = parts.next()?.parse().ok()?;
    Some(DiskUsage { total_kb, used_kb })
}

fn parse_net(value: &str) -> Option<(u64, u64)> {
    let mut parts = value.split_whitespace();
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

/// ps 行：`pid pmem rss comm`，comm 可能含空格，其余字段按空白切分。
fn parse_process(line: &str) -> Option<ProcessUsage> {
    let mut parts = line.split_whitespace();
    let pid = parts.next()?.parse().ok()?;
    let mem_percent = parts.next()?.parse().ok()?;
    let rss_kb = parts.next()?.parse().ok()?;
    let name = parts.collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return None;
    }
    Some(ProcessUsage {
        pid,
        name,
        mem_percent,
        rss_kb,
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
