//! ChannelGatewayImpl 验收测试：真实 sshd 全链路（SPEC「文件与连接接入」）。
//!
//! 测试设施：在本机以独立配置拉起真实 sshd（非默认端口、独立主机密钥、
//! 测试账号），server 通过 ursi-channel（russh 客户端）执行 SSH exec 与
//! SFTP put/get，覆盖 exec/文件往返与错误映射。测试结束（含 panic）均
//! 停止 sshd 并还原系统账号文件。
//!
//! 说明： ursi-server 不直接依赖 russh（channel crate 的进程内 russh sshd
//! 测试设施属其集成测试，不可跨 crate 复用），故本模块测试用真实 sshd。

use std::io::Write as _;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tempfile::TempDir;
use ursi_channel::endpoint::{AuthMethod, EndpointMode};

use super::{ChannelAccessConfig, ChannelGatewayImpl};
use crate::sandboxes::traits::channel::{
    ChannelAccessError, ChannelGateway, ChannelTarget,
};

/// 测试账号前缀（每个测试实例追加递增后缀，避免并发生命周期交叉）；
/// uid/gid 取未占用高位段，仅测试期存在于 /etc/passwd|shadow。
const TEST_USER_PREFIX: &str = "ursi_sbx_test";
const TEST_UID: u32 = 30001;
const TEST_PASSWORD: &str = "ursi-sbx-test-password";

/// 实例计数：并发测试各自独立用户名（同 uid）。
static NEXT_INSTANCE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// 测试实例的账号名（spawn 时分配）。
fn test_user_name(instance: u32) -> String {
    format!("{TEST_USER_PREFIX}_{instance}")
}

/// 下一个可用的 sshd 端口（避免并行测试冲突，从高位递增）。
static NEXT_PORT: AtomicU16 = AtomicU16::new(23300);

/// 账号文件读写互斥：/etc/passwd 追加与按用户删除都是「读改写」，
/// 并发测试并行执行时必须互斥，避免窗口期互相覆盖条目。
fn account_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 真实 sshd 测试实例：目录、端口与生命周期守卫。
struct TestSshd {
    /// 生命周期守卫（先于 _dir drop：先停 sshd 并清理账号，再删目录）。
    _guard: SshdGuard,
    _dir: TempDir,
    port: u16,
    host: String,
    user: String,
    password: String,
    workspace: PathBuf,
}

/// sshd 生命周期守卫：drop（含 panic unwind）时停进程并还原系统文件。
struct SshdGuard {
    pid_file: PathBuf,
    /// 本实例的账号名（独立用户名，清理互不影响）。
    user: String,
    /// 测试根目录（drop 时把属主交还当前用户，TempDir 才能删净）。
    root: PathBuf,
}

impl Drop for SshdGuard {
    fn drop(&mut self) {
        // 与 provision 的读改写互斥（同进程并发测试）。
        let _guard = account_lock().lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(pid) = std::fs::read_to_string(&self.pid_file) {
            let _ = Command::new("sudo")
                .args(["kill", pid.trim()])
                .status();
        }
        // 按用户名删除本实例条目（独立用户名，不整文件覆盖）。
        let _ = Command::new("sudo")
            .args(["python3", "-c", REMOVE_USER_PY, &self.user])
            .status();
        // 属主交还当前用户，保证随后的 TempDir drop 能删净目录。
        let uid = current_uid();
        let root_str = self.root.to_string_lossy().into_owned();
        let _ = Command::new("sudo")
            .args(["chown", "-R", &format!("{uid}:{uid}"), &root_str])
            .status();
    }
}

/// 当前 uid（TempDir 属主；读进程状态，不经 libc）。
fn current_uid() -> u32 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("Uid:\t") {
            if let Some(real) = rest.split_whitespace().next() {
                if let Ok(v) = real.parse::<u32>() {
                    return v;
                }
            }
        }
    }
    1000
}

/// 按用户名删除 /etc/passwd 与 /etc/shadow 条目的 python 脚本。
const REMOVE_USER_PY: &str = r#"
import sys
user = sys.argv[1]
for path in ("/etc/passwd", "/etc/shadow"):
    with open(path) as f:
        lines = [l for l in f.read().splitlines() if not l.startswith(user + ":")]
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
print("restored")
"#;

/// 追加测试账号到 /etc/passwd 与 /etc/shadow（crypt SHA-512 哈希，固定盐）。
fn provision_account(user: &str, home: &std::path::Path) {
    // 与 Drop 清理的读改写互斥（同进程并发测试）。
    let _guard = account_lock().lock().unwrap_or_else(|e| e.into_inner());
    // 密码哈希用固定盐预计算，避免 shell 传参转义问题。
    let hash = Command::new("python3")
        .args([
            "-c",
            &format!("import crypt; print(crypt.crypt('{TEST_PASSWORD}', '$6$ursisbx$'))"),
        ])
        .output()
        .expect("计算密码哈希")
        .stdout;
    let hash = String::from_utf8_lossy(&hash).trim().to_string();
    assert!(hash.starts_with("$6$"), "哈希异常：{hash}");
    let line = format!("{user}:{hash}:{TEST_UID}:{TEST_UID}:ursi sshd test,,,:{}", home.display());
    let shadow_line = format!("{user}:{hash}:20000:0:99999:7:::");
    let script = "
import sys
for path, line in ((sys.argv[1], sys.argv[3]), (sys.argv[2], sys.argv[4])):
    with open(path) as f:
        content = f.read()
    if sys.argv[5] + ':' not in content:
        with open(path, 'a') as f:
            f.write(line + '\\n')
print('provisioned')
";
    let out = Command::new("sudo")
        .args([
            "python3",
            "-c",
            script,
            "/etc/passwd",
            "/etc/shadow",
            &line,
            &shadow_line,
            user,
        ])
        .output()
        .expect("写入测试账号（需 sudo）");
    assert!(
        out.status.success(),
        "写入测试账号失败：{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// 启动真实 sshd：独立端口、独立主机密钥、internal-sftp、密码与公钥鉴权。
fn spawn_sshd() -> TestSshd {
    let dir = TempDir::new().expect("创建临时目录");
    let root = dir.path();
    let port = NEXT_PORT.fetch_add(1, Ordering::SeqCst);
    // 每实例独立用户名：并发测试生命周期交叉时清理互不影响。
    let instance = NEXT_INSTANCE.fetch_add(1, Ordering::SeqCst);
    let user = test_user_name(instance);
    let home = root.join("home").join(&user);
    std::fs::create_dir_all(home.join(".ssh")).expect("创建测试 home");

    provision_account(&user, &home);

    let host_key = root.join("hostkey");
    let status = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&host_key)
        .status()
        .expect("生成主机密钥");
    assert!(status.success(), "ssh-keygen 失败");

    let pid_file = root.join("sshd.pid");
    let log_file = root.join("sshd.log");
    let config_file = root.join("sshd_config");
    let mut config = std::fs::File::create(&config_file).expect("创建 sshd 配置");
    writeln!(config, "Port {port}").unwrap();
    writeln!(config, "ListenAddress 127.0.0.1").unwrap();
    writeln!(config, "HostKey {}", host_key.display()).unwrap();
    writeln!(config, "PidFile {}", pid_file.display()).unwrap();
    writeln!(config, "UsePAM no").unwrap();
    writeln!(config, "PasswordAuthentication yes").unwrap();
    writeln!(config, "KbdInteractiveAuthentication no").unwrap();
    writeln!(config, "PubkeyAuthentication yes").unwrap();
    writeln!(config, "StrictModes no").unwrap();
    writeln!(config, "Subsystem sftp internal-sftp").unwrap();
    writeln!(config, "LogLevel INFO").unwrap();
    drop(config);

    let status = Command::new("sudo")
        .args([
            "/usr/sbin/sshd",
            "-f",
        ])
        .arg(&config_file)
        .arg("-E")
        .arg(&log_file)
        .status()
        .expect("启动 sshd（需 sudo）");
    assert!(status.success(), "sshd 启动失败，日志：{}", std::fs::read_to_string(&log_file).unwrap_or_default());
    std::thread::sleep(std::time::Duration::from_millis(400));
    assert!(
        Command::new("bash")
            .arg("-c")
            .arg(format!("ss -ltn | grep -q ':{port} '"))
            .status()
            .map(|s| s.success())
            .unwrap_or(false),
        "sshd 未在端口 {port} 监听"
    );

    let workspace = home.join("workspace");
    std::fs::create_dir_all(&workspace).expect("创建工作目录");
    let status = Command::new("sudo")
        .args(["chown", "-R", &format!("{TEST_UID}:{TEST_UID}")])
        .arg(root.join("home"))
        .status()
        .expect("修正 home 属主");
    assert!(status.success());

    let guard = SshdGuard {
        pid_file: pid_file.clone(),
        user: user.clone(),
        root: root.to_path_buf(),
    };
    TestSshd {
        _guard: guard,
        _dir: dir,
        port,
        host: "127.0.0.1".into(),
        user,
        password: TEST_PASSWORD.into(),
        workspace,
    }
}

fn target(sandbox_id: &str) -> ChannelTarget {
    ChannelTarget {
        sandbox_id: sandbox_id.into(),
        endpoint: Some("ssh".into()),
    }
}

fn gateway(sshd: &TestSshd) -> ChannelGatewayImpl {
    ChannelGatewayImpl::new(ChannelAccessConfig {
        ssh_port: sshd.port,
        ssh_host: sshd.host.clone(),
        auth: AuthMethod::Password {
            user: sshd.user.clone(),
            password: sshd.password.clone(),
        },
        mode: EndpointMode::Direct,
    })
}

// ---------------------------------------------------------------------------
// SPEC「文件与连接接入」验收：exec 与文件通道真实走通
// ---------------------------------------------------------------------------

/// 验收（文件与连接接入）：命令返回输出与退出状态——真实 sshd 上执行
/// echo（退出 0）与 false（退出 1）。
#[tokio::test]
async fn exec_命令返回输出与退出状态() {
    let sshd = spawn_sshd();
    let g = gateway(&sshd);

    let out = g
        .open_exec_channel(&target("sbx-1"), "echo channel-exec-ok")
        .await
        .expect("exec 成功");
    assert_eq!(out.exit_code, 0);
    assert!(out.output.contains("channel-exec-ok"), "{}", out.output);

    let out = g
        .open_exec_channel(&target("sbx-1"), "false")
        .await
        .expect("exec 成功（非零退出不算通道故障）");
    assert_eq!(out.exit_code, 1);
}

/// 验收（文件与连接接入）：文件通道收到指定目标、路径与原始内容，
/// 回读保持完整——真实 sshd SFTP 写入后读回逐字节比对。
#[tokio::test]
async fn 文件通道往返内容完整() {
    let sshd = spawn_sshd();
    let g = gateway(&sshd);
    let path = sshd.workspace.join("input.txt");
    let path_str = path.to_string_lossy().into_owned();

    // 覆盖端点缺省（None）与显式端点名两种目标身份。
    let bytes = "ursi 文件往返 ✓ bytes".as_bytes().to_vec();
    let len = g
        .open_file_channel(&target("sbx-1"), &path_str, &bytes)
        .await
        .expect("文件通道成功");
    assert_eq!(len, bytes.len());
    let written = std::fs::read(&path).expect("文件已落盘");
    assert_eq!(written, bytes, "回读内容与原始内容一致");

    // 无端点名（默认端点）同样可接入。
    let t = ChannelTarget { sandbox_id: "sbx-1".into(), endpoint: None };
    let len = g
        .open_file_channel(&t, &path_str, b"again")
        .await
        .expect("默认端点成功");
    assert_eq!(len, 5);
}

/// 验收（文件与连接接入）：错误身份与不可达端点返回可区分错误——
/// 错误密码 → Auth，错误端口 → Unreachable。
#[tokio::test]
async fn 错误身份与不可达端点可区分() {
    let sshd = spawn_sshd();
    let wrong_auth = ChannelGatewayImpl::new(ChannelAccessConfig {
        ssh_port: sshd.port,
        ssh_host: sshd.host.clone(),
        auth: AuthMethod::Password {
            user: sshd.user.clone(),
            password: "wrong-password".into(),
        },
        mode: EndpointMode::Direct,
    });
    let err = wrong_auth
        .open_exec_channel(&target("sbx-1"), "echo hi")
        .await
        .unwrap_err();
    assert!(matches!(err, ChannelAccessError::Auth(_)), "{err}");

    let unreachable = ChannelGatewayImpl::new(ChannelAccessConfig {
        ssh_port: 1, // 保留端口，必然不可达
        ssh_host: "127.0.0.1".into(),
        auth: AuthMethod::Password {
            user: sshd.user.clone(),
            password: sshd.password.clone(),
        },
        mode: EndpointMode::Direct,
    });
    let err = unreachable
        .open_exec_channel(&target("sbx-1"), "echo hi")
        .await
        .unwrap_err();
    assert!(matches!(err, ChannelAccessError::Unreachable(_)), "{err}");
}

/// 接口层记录：close_sandbox 幂等回收（无驻留句柄时不 panic、不报错），
/// 回收后通道访问照常可用（连接按需重建；连接关闭不通知远端任务取消）。
#[tokio::test]
async fn close_sandbox_回收幂等且访问可恢复() {
    let sshd = spawn_sshd();
    let g = Arc::new(gateway(&sshd));

    g.close_sandbox("sbx-1").await;
    g.close_sandbox("sbx-1").await; // 幂等

    // 回收后连接按需重建，exec 照常可用。
    let out = g
        .open_exec_channel(&target("sbx-1"), "echo after-close")
        .await
        .expect("回收后访问可用");
    assert!(out.output.contains("after-close"), "{}", out.output);
}

/// terminal 句柄：ursi-channel 首版未提供 PTY 接入，返回明确错误（留位）。
#[tokio::test]
async fn 终端明确报_pty_未接入() {
    let sshd = spawn_sshd();
    let g = gateway(&sshd);
    let err = g.open_terminal(&target("sbx-1")).await.unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("PTY"), "{msg}");
}

/// 隧道模式：真实隧道升级验证后明确报告 SSH 承载待补齐（Notes 记录）。
#[tokio::test]
async fn 隧道模式无真实网关时报不可达() {
    let g = ChannelGatewayImpl::new(ChannelAccessConfig {
        ssh_port: 22,
        ssh_host: String::new(),
        auth: AuthMethod::Password {
            user: "u".into(),
            password: "p".into(),
        },
        mode: EndpointMode::Tunnel {
            gateway_ws_url: "ws://127.0.0.1:1".into(), // 无网关监听
            bearer_token: "tunnel-token-0123456789".into(),
        },
    });
    let err = g
        .open_exec_channel(&target("sbx-t"), "echo hi")
        .await
        .unwrap_err();
    assert!(matches!(err, ChannelAccessError::Unreachable(_)), "{err}");
}
