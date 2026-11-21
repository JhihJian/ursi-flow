use serde_json::{Value, json};
use std::{
    io::{self, Write},
    path::Path,
    time::Duration,
};
use ursi_sandbox_client::{Error, Gateway, Result, Secret, Ssh};

#[cfg(feature = "acp")]
#[path = "../consumers/acp/cli.rs"]
mod acp_cli;

const HELP: &str = r#"ursi-sandbox-client：独立 Gateway、SSH/SFTP 客户端

命令（固定位置参数，文件内容使用 UTF-8）：
  gateway capabilities | list
  gateway create SPEC_JSON_FILE
  gateway status|start|stop|delete|endpoints SANDBOX_ID
  forward SANDBOX_ID ENDPOINT_NAME [LOCAL_ADDR]
  ssh SANDBOX_ID ENDPOINT_NAME PRIVATE_KEY_FILE KNOWN_HOSTS_FILE SCRIPT_FILE
  sftp-put|sftp-get SANDBOX_ID ENDPOINT_NAME PRIVATE_KEY_FILE KNOWN_HOSTS_FILE LOCAL_FILE REMOTE_FILE

配置：
  URSI_GATEWAY_URL                  例如 http://127.0.0.1:8899
  URSI_GATEWAY_KEY[_FILE]           二选一，值或凭据文件
  URSI_CLIENT_TIMEOUT_SECS          每操作总期限，默认 120 秒

SSH 固定 agent 用户、仅公钥，独立 known_hosts 首次信任，之后拒绝密钥变化。
"#;

fn arg(args: &[String], index: usize) -> Result<&str> {
    args.get(index)
        .map(String::as_str)
        .ok_or_else(|| Error::Invalid("缺少参数，运行 --help 查看说明".into()))
}
fn count(args: &[String], expected: usize) -> Result<()> {
    if args.len() == expected {
        Ok(())
    } else {
        Err(Error::Invalid("参数数量错误，运行 --help 查看说明".into()))
    }
}
fn env(name: &str) -> Result<String> {
    std::env::var(name).map_err(|_| Error::Invalid(format!("需要环境变量 {name}")))
}
fn emit(mut value: Value) {
    for name in ["URSI_GATEWAY_KEY"] {
        if let Ok(secret) = Secret::from_env(name) {
            value = secret.redact_json(&value);
        }
    }
    println!("{value}");
    let _ = io::stdout().flush();
}
fn result(value: Value) {
    emit(json!({"type":"result","result":value}));
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || matches!(args[0].as_str(), "help" | "--help" | "-h") {
        print!("{HELP}");
        #[cfg(feature = "acp")]
        print!("{}", acp_cli::HELP);
        return;
    }
    match run(&args).await {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            // 输出层再次过滤 Gateway 身份，避免对端回显。
            let mut message = error.to_string();
            for name in ["URSI_GATEWAY_KEY"] {
                if let Ok(secret) = Secret::from_env(name) {
                    message = secret.redact(&message);
                }
            }
            eprintln!("{}", json!({"type":"error","message":message}));
            std::process::exit(1);
        }
    }
}
async fn run(args: &[String]) -> Result<i32> {
    let seconds = std::env::var("URSI_CLIENT_TIMEOUT_SECS")
        .unwrap_or_else(|_| "120".into())
        .parse::<u64>()
        .ok()
        .filter(|n| (1..=86400).contains(n))
        .ok_or_else(|| Error::Invalid("timeout 应在 1..86400 秒".into()))?;
    let timeout = Duration::from_secs(seconds);
    match arg(args, 0)? {
        "gateway" => {
            let operation = arg(args, 1)?;
            let (method, path, body) = match operation {
                "capabilities" | "list" => {
                    count(args, 2)?;
                    (
                        reqwest::Method::GET,
                        format!(
                            "/api/v1/{}",
                            if operation == "list" {
                                "sandboxes"
                            } else {
                                "capabilities"
                            }
                        ),
                        None,
                    )
                }
                "create" => {
                    count(args, 3)?;
                    let body = serde_json::from_slice::<Value>(&std::fs::read(arg(args, 2)?)?)
                        .map_err(|_| Error::Invalid("规格文件不是 JSON".into()))?;
                    (
                        reqwest::Method::POST,
                        "/api/v1/sandboxes".into(),
                        Some(body),
                    )
                }
                "status" | "start" | "stop" | "delete" | "endpoints" => {
                    count(args, 3)?;
                    let id = arg(args, 2)?;
                    if id.is_empty()
                        || !id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                    {
                        return Err(Error::Invalid("沙箱 ID 无效".into()));
                    }
                    let method = match operation {
                        "start" | "stop" => reqwest::Method::POST,
                        "delete" => reqwest::Method::DELETE,
                        _ => reqwest::Method::GET,
                    };
                    let suffix = match operation {
                        "start" => "/start",
                        "stop" => "/stop",
                        "endpoints" => "/endpoints",
                        _ => "",
                    };
                    (method, format!("/api/v1/sandboxes/{id}{suffix}"), None)
                }
                _ => return Err(Error::Invalid("未知 Gateway 命令".into())),
            };
            let gateway = Gateway::new(
                &env("URSI_GATEWAY_URL")?,
                Secret::from_env("URSI_GATEWAY_KEY")?,
                timeout,
            )?;
            if operation == "endpoints" {
                result(json!({"endpoints": gateway.endpoints(arg(args, 2)?).await?}));
            } else {
                result(gateway.request(method, &path, body).await?);
            }
        }
        "forward" => {
            if !(args.len() == 3 || args.len() == 4) {
                return Err(Error::Invalid("参数数量错误，运行 --help 查看说明".into()));
            }
            let listen = args
                .get(3)
                .map(String::as_str)
                .unwrap_or("127.0.0.1:0")
                .parse()
                .map_err(|_| Error::Invalid("本地监听地址无效".into()))?;
            let gateway = Gateway::new(
                &env("URSI_GATEWAY_URL")?,
                Secret::from_env("URSI_GATEWAY_KEY")?,
                timeout,
            )?;
            let bridge = gateway.bridge(arg(args, 1)?, arg(args, 2)?, listen).await?;
            let address = bridge.local_addr()?;
            result(json!({"listen": address.to_string()}));
            let (cancel, receiver) = tokio::sync::watch::channel(false);
            tokio::spawn(async move {
                let _ = tokio::signal::ctrl_c().await;
                let _ = cancel.send(true);
            });
            bridge.run_until(receiver).await?;
            return Ok(0);
        }
        #[cfg(feature = "acp")]
        "acp" => return acp_cli::run(args, timeout).await,
        "ssh" | "sftp-put" | "sftp-get" => {
            let operation = arg(args, 0)?;
            count(args, if operation == "ssh" { 6 } else { 7 })?;
            let gateway = Gateway::new(
                &env("URSI_GATEWAY_URL")?,
                Secret::from_env("URSI_GATEWAY_KEY")?,
                timeout,
            )?;
            let bridge = gateway
                .bridge(arg(args, 1)?, arg(args, 2)?, "127.0.0.1:0".parse().unwrap())
                .await?;
            let address = bridge.local_addr()?;
            let (host, port) = match address {
                std::net::SocketAddr::V4(address) => ("127.0.0.1".into(), address.port()),
                std::net::SocketAddr::V6(address) => ("[::1]".into(), address.port()),
            };
            let (bridge_control, receiver) = tokio::sync::watch::channel(false);
            let bridge_task = tokio::spawn(bridge.run_until(receiver));
            let ssh = Ssh {
                host,
                port,
                identity: arg(args, 3)?.into(),
                known_hosts: arg(args, 4)?.into(),
                timeout,
            };
            let output = if operation == "ssh" {
                ssh.run(&std::fs::read(arg(args, 5)?)?).await?
            } else {
                ssh.transfer(
                    operation == "sftp-put",
                    Path::new(arg(args, 5)?),
                    arg(args, 6)?,
                )
                .await?
            };
            // SSH 内容是调用方显式请求的仓库输出，身份配置不放入脚本。
            let mut stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let mut stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            for name in ["URSI_GATEWAY_KEY"] {
                if let Ok(secret) = Secret::from_env(name) {
                    stdout = secret.redact(&stdout);
                    stderr = secret.redact(&stderr);
                }
            }
            result(
                json!({"success":output.status.success(),"code":output.status.code(),"stdout":stdout,"stderr":stderr}),
            );
            let _ = bridge_control.send(true);
            let _ = bridge_task.await;
            return Ok(if output.status.success() { 0 } else { 1 });
        }
        _ => return Err(Error::Invalid("未知命令，运行 --help 查看说明".into())),
    }
    Ok(0)
}
