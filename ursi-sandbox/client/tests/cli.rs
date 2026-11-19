use std::process::Command;

#[test]
fn help_describes_gateway_only_endpoint_access() {
    let help = Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(help.status.success());
    let help_text = String::from_utf8_lossy(&help.stdout);
    assert!(help_text.contains("URSI_GATEWAY_KEY"));
    assert!(help_text.contains("forward SANDBOX_ID ENDPOINT_NAME"));
    assert!(!help_text.contains("HOST PORT"));
}

#[test]
fn direct_acp_url_is_rejected() {
    let output = Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .args(["acp", "initialize"])
        .env("URSI_ACP_URL", "ws://127.0.0.1:1/acp")
        .env_remove("URSI_SANDBOX_ID")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("URSI_SANDBOX_ID"));
}

#[test]
fn unknown_arguments_fail() {
    let output = Command::new(env!("CARGO_BIN_EXE_ursi-sandbox-client"))
        .args(["gateway", "list", "unexpected"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
}
