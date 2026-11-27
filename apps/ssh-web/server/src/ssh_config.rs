//! 从本机 `~/.ssh/config` 发现可批量导入的 SSH 主机。
//!
//! 不自己解析配置文件：token 化、Include 展开与通配符匹配都是 OpenSSH 自身的语义，
//! 这里直接调用 `ssh -G <host>` 让 OpenSSH 给出最终生效配置，只抽 user 与 port。

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use tokio::process::Command;

use crate::models::DiscoveredHost;

/// 单台主机名允许的最长长度（DNS 主机名上限，Host 别名一般远短于此）。
const MAX_HOST_LENGTH: usize = 255;

/// OpenSSH 的通配符与否定模式，这类条目不是一台具体主机，不能导入。
fn is_pattern(host: &str) -> bool {
    host.contains(['*', '?', '!'])
}

/// 批量 ssh 的基础参数：-G 只读本机配置，BatchMode 禁止交互。
fn ssh_g_args(host: &str) -> Vec<String> {
    ["-G".to_string(), "-o".to_string(), "BatchMode=yes".to_string(), host.to_string()].into_iter().collect()
}

/// 列出配置里声明的具体主机别名（`grep ^Host`，跳过通配模式与否定条目）。
pub async fn list_config_hosts() -> Result<Vec<String>> {
    let config = ssh_config_path()?;
    let output = tokio::process::Command::new("grep")
        .arg("^Host")
        .arg(&config)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .context("读取 ssh config 失败")?;
    if !output.status.success() && output.stdout.is_empty() {
        // grep 没匹配到任何 Host 行时退出码为 1，属于正常空态。
        if output.status.code() == Some(1) {
            return Ok(Vec::new());
        }
        return Err(anyhow!("读取 ssh config 失败（exit {}）", output.status));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut hosts = Vec::new();
    for line in text.lines() {
        // 只取 Host 指令行的别名列表：HostName/HostKey* 因后接非空格字符不会命中前缀。
        let rest = match line.strip_prefix("Host ") {
            Some(rest) => rest,
            None => continue,
        };
        for host in rest.split_whitespace() {
            if !is_pattern(host) && host.len() <= MAX_HOST_LENGTH && !hosts.contains(&host.to_string()) {
                hosts.push(host.to_string());
            }
        }
    }
    Ok(hosts)
}

fn ssh_config_path() -> Result<PathBuf> {
    let home = std::env::var("HOME").map_err(|_| anyhow!("无法确定用户 HOME 目录"))?;
    let path = PathBuf::from(home).join(".ssh").join("config");
    if !path.is_file() {
        return Err(anyhow!("{} 不存在", path.display()));
    }
    Ok(path)
}

/// 查询单台主机的最终生效配置（ssh -G），抽出 user 与 port。
/// 别名、Include、Match 条件都由 OpenSSH 自身解释，这里只读结果。
async fn query_host(host: &str) -> Result<(Option<String>, Option<u16>)> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        Command::new("ssh")
            .args(ssh_g_args(host))
            .stdin(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| anyhow!("ssh -G {host} 超时"))?
    .context("启动 ssh -G 失败")?;
    anyhow::ensure!(
        output.status.success(),
        "ssh -G {host} 失败：{}",
        String::from_utf8_lossy(&output.stderr).trim()
    );

    let text = String::from_utf8_lossy(&output.stdout);
    let mut user = None;
    let mut port = None;
    for line in text.lines() {
        let mut fields = line.splitn(2, ' ');
        match fields.next() {
            Some("user") => user = fields.next().filter(|value| !value.is_empty()).map(String::from),
            Some("port") => {
                port = fields.next().and_then(|value| value.parse().ok()).filter(|value| *value != 22);
            }
            _ => {}
        }
    }
    Ok((user, port))
}

/// 发现全部可导入主机：先 grep 出别名，再逐台查最终配置。
/// 单台查询失败不阻断其余主机，返回仍可导入的部分。
pub async fn discover_hosts() -> Result<Vec<DiscoveredHost>> {
    let hosts = list_config_hosts().await?;
    let mut discovered = Vec::with_capacity(hosts.len());
    for host in hosts {
        match query_host(&host).await {
            Ok((user, port)) => discovered.push(DiscoveredHost { host, user, port }),
            // ssh -G 只读本机配置，失败多为主机名非法（如包含逗号的模式残留），跳过即可。
            Err(_) => continue,
        }
    }
    Ok(discovered)
}
