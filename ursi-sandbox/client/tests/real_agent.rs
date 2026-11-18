//! 显式 opt-in 的真实验收入口。需要已集成的 Gateway、Runtime 镜像和 bundle。
#[test]
#[ignore = "需要 URSI_AGENT_ACCEPTANCE=1、正式镜像/bundle 和真实模型配置"]
fn real_pi_agent_acceptance() {
    assert_eq!(
        std::env::var("URSI_AGENT_ACCEPTANCE").as_deref(),
        Ok("1"),
        "必须显式启用真实模型验收"
    );
    let mut command = std::process::Command::new("python3");
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/scripts/agent_acceptance.py"
        ))
        .args(["--client", env!("CARGO_BIN_EXE_ursi-sandbox-client")]);
    for (flag, variable) in [
        ("--gateway", "URSI_ACCEPTANCE_GATEWAY"),
        ("--bundle", "URSI_ACCEPTANCE_BUNDLE"),
        ("--config-dir", "URSI_ACCEPTANCE_CONFIG_DIR"),
    ] {
        command
            .arg(flag)
            .arg(std::env::var(variable).unwrap_or_else(|_| panic!("需要 {variable}")));
    }
    for (flag, variable) in [
        ("--image", "URSI_ACCEPTANCE_IMAGE"),
        ("--ssh-key", "URSI_ACCEPTANCE_SSH_KEY"),
        ("--bundle-host", "URSI_ACCEPTANCE_BUNDLE_HOST"),
        ("--evidence", "URSI_ACCEPTANCE_EVIDENCE"),
    ] {
        if let Ok(value) = std::env::var(variable) {
            command.arg(flag).arg(value);
        }
    }
    assert!(
        command.status().expect("运行 Python3 验收脚本").success(),
        "真实验收失败，查看脱敏证据"
    );
}
