//! 独立二进制必须在接触Docker或监听端口前拒绝无效管理凭据。
use std::process::Command;

#[test]
fn standalone_process_refuses_missing_short_and_whitespace_keys() {
    for key in [None, Some("short"), Some("invalid key with whitespace")] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ursi-gateway"));
        command.env_remove("URSI_GATEWAY_KEY");
        if let Some(key) = key {
            command.env("URSI_GATEWAY_KEY", key);
        }
        let output = command.output().unwrap();
        assert!(!output.status.success());
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains("URSI_GATEWAY_KEY"));
        if let Some(key) = key {
            assert!(!error.contains(key));
        }
    }
}
