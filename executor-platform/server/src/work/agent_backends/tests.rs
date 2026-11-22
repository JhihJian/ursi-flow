use super::*;
use crate::work::{Store, directories};
use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt, symlink},
    path::Path,
    process::Command,
};
use uuid::Uuid;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        Self(dir)
    }
    fn file(&self, name: &str, data: &[u8], mode: u32) -> PathBuf {
        let path = self.0.join(name);
        fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(mode)
            .open(&path)
            .unwrap()
            .write_all(data)
            .unwrap();
        path
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap()
    }
}
fn row(bin: &Path) -> Value {
    json!({"id":"reviewer","label":"审阅助手","capabilities":["skills"],"bin":bin})
}

#[test]
fn invalid_explicit_configuration_is_never_silently_discarded() {
    let t = Temp::new();
    let policy = t.file("policy", b"{}", 0o600);
    let good = row(Path::new("/bin/true"));
    let registry = t.file("backends", json!([good]).to_string().as_bytes(), 0o600);
    let load = || Registry::load(None, Some(policy.clone()), Some(registry.clone()));
    assert_eq!(load().unwrap().lookup("reviewer").unwrap().policy, policy);
    for (field, value) in [
        ("id", json!("pi")),
        ("id", json!("flow")),
        ("id", json!("../x")),
        ("id", json!("a b")),
        ("label", json!("")),
        ("capabilities", json!(["skills", "skills"])),
        ("capabilities", json!(["shell"])),
        ("bin", json!("relative")),
        ("bin", json!(t.0)),
        ("bin", json!(policy)),
        ("bin", json!(t.0.join("missing"))),
        ("command", json!("private argument")),
    ] {
        let mut bad = good.clone();
        bad[field] = value;
        fs::write(&registry, json!([bad]).to_string()).unwrap();
        let err = load().err().expect("显式无效配置必须报错");
        assert!(!err.to_string().contains(t.0.to_str().unwrap()));
    }
    for bad in [
        json!([good, good]),
        good.clone(),
        json!([["x", "label", "/bin/true", []]]),
    ] {
        fs::write(&registry, bad.to_string()).unwrap();
        assert!(load().is_err());
    }
    fs::write(&registry, b"[").unwrap();
    assert!(load().is_err());
    fs::write(&registry, json!([good]).to_string()).unwrap();
    assert!(Registry::load(None, None, Some(registry.clone())).is_err());
    assert!(Registry::load(Some("/bin/true".into()), None, None).is_err());
    assert!(Registry::load(Some("relative".into()), Some(policy.clone()), None).is_err());
    assert!(Registry::load(None, None, Some("relative".into())).is_err());
    let link = t.0.join("link");
    symlink(&registry, &link).unwrap();
    assert!(Registry::load(None, Some(policy.clone()), Some(link)).is_err());
    fs::set_permissions(&registry, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(load().is_err());
    fs::set_permissions(&policy, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(Registry::load(None, Some(policy), None).is_err());
}

#[test]
fn selection_uses_shared_health_and_only_required_capabilities() {
    let t = Temp::new();
    let bin = PathBuf::from("/bin/true");
    let policy = t.file("policy", b"{}", 0o600);
    let managed = t.file("managed", json!([row(&bin)]).to_string().as_bytes(), 0o600);
    let reg = Registry::load(Some(bin), Some(policy), Some(managed)).unwrap();
    let clone = reg.clone();
    let skills = json!({"skills":[{"id":"draft"}],"tools":[]});
    let tools = json!({"skills":[],"tools":[{"id":"lookup"}]});
    assert!(reg.select(None, &skills).is_err());
    assert!(reg.select(Some("pi"), &skills).is_err());
    assert!(reg.lookup("flow").is_err());
    assert_eq!(reg.lookup("pi").unwrap().id, "pi");
    clone
        .health()
        .unwrap()
        .insert("reviewer".into(), Check::finished(true));
    assert_eq!(reg.select(None, &skills).unwrap().id, "reviewer");
    assert!(reg.select(None, &tools).is_err());
    clone
        .health()
        .unwrap()
        .insert("pi".into(), Check::finished(true));
    assert!(matches!(reg.select(None, &skills), Err(Error::Conflict(_))));
    assert_eq!(reg.select(None, &tools).unwrap().id, "pi");
    assert!(matches!(
        reg.select(Some("reviewer"), &tools),
        Err(Error::Invalid(_))
    ));
    assert_eq!(
        reg.select(Some("reviewer"), &skills).unwrap().id,
        "reviewer"
    );
    clone
        .health()
        .unwrap()
        .insert("reviewer".into(), Check::finished(false));
    assert!(reg.select(Some("reviewer"), &skills).is_err());
    assert_eq!(reg.lookup("reviewer").unwrap().id, "reviewer");
}

// The catalog reads URSI_PI_POLICY. Only the child process sees the fixture environment.
#[tokio::test]
async fn http_directory_probe_and_package_preview() {
    if std::env::var_os("URSI_TEST_BACKENDS_CHILD").is_none() {
        let t = Temp::new();
        let policy = t.file(
            "policy",
            br#"{"models":[{"id":"m","provider":{}}],"tools":[]}"#,
            0o600,
        );
        let bin = t.file("adapter", br#"#!/usr/bin/python3
import json, os, sys
assert os.path.isdir(os.environ['URSI_EXECUTOR_ROOT'])
def reply(req, result): print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}), flush=True)
reply(json.loads(input()), {'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'example','version':'1'}})
assert json.loads(input())['method'] == 'notifications/initialized'
r=json.loads(input()); assert r['method'] == 'tools/list'
reply(r, {'tools':[{'name':n,'inputSchema':{'type':'object'}} for n in ['executor_start','executor_inspect','executor_cancel']]})
assert sys.stdin.read() == ''
"#, 0o700);
        let mut managed = row(&bin);
        managed["capabilities"] = json!([]);
        let path = t.file("managed", json!([managed]).to_string().as_bytes(), 0o600);
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                std::thread::current().name().unwrap(),
                "--nocapture",
            ])
            .env("URSI_TEST_BACKENDS_CHILD", &t.0)
            .env("URSI_AGENT_BACKENDS", path)
            .env("URSI_PI_POLICY", policy)
            .env_remove("URSI_PI_EXECUTOR_BIN")
            .output()
            .unwrap();
        assert!(
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains("1 passed"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let temp = PathBuf::from(std::env::var_os("URSI_TEST_BACKENDS_CHILD").unwrap());
    let reg = Registry::from_env().unwrap();
    let store = Store::open(temp.join("store")).unwrap();
    let root = store.dir().join("executor-workspaces");
    let socket = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let url = format!("http://{}/v2/agent-backends", socket.local_addr().unwrap());
    let app = reg.routes(store.clone());
    let server = tokio::spawn(async move { axum::serve(socket, app).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let all: Value = client
        .get(&url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        all[0],
        json!({"id":"pi","label":"Pi","capabilities":["skills","tools","flowOutcome"],"configured":false,"status":"unchecked","checkedAt":null})
    );
    assert_eq!(
        all[1],
        json!({"id":"reviewer","label":"审阅助手","capabilities":[],"configured":true,"status":"unchecked","checkedAt":null})
    );
    assert!(reg.lookup("pi").is_err());
    assert!(!root.exists());
    let check = |id| client.post(format!("{url}/{id}/check")).send();
    assert_eq!(check("missing").await.unwrap().status(), 404);
    let item: Value = check("reviewer")
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(item["status"], "ready");
    assert!(item["checkedAt"].as_u64().unwrap() > 0);
    assert_eq!(root.metadata().unwrap().mode() & 0o777, 0o700);
    assert_eq!(
        reg.select(None, &json!({"skills":[],"tools":[]}))
            .unwrap()
            .id,
        "reviewer"
    );
    let package = directories::allocate(
        &store,
        Default::default(),
        |dir| {
            fs::write(dir.join("AGENTS.md"), "instruction").unwrap();
            fs::write(dir.join("mcp.json"), "{}").unwrap();
            fs::create_dir_all(dir.join("skills/sample")).unwrap();
            fs::write(dir.join("skills/sample/SKILL.md"), "sample").unwrap();
            Ok(())
        },
        |db, dir| {
            db["configPatches"]["draft"] = json!({"id":"draft","directoryId":dir});
            Ok("draft")
        },
    )
    .unwrap();
    let filtered: Value = client
        .get(&url)
        .query(&[("configPackageId", package)])
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(filtered[0]["compatible"], true);
    assert_eq!(filtered[1]["compatible"], false);
    assert_eq!(filtered[1]["checkedAt"], item["checkedAt"]);
    assert!(!filtered.to_string().contains(temp.to_str().unwrap()));
    let missing = client
        .get(&url)
        .query(&[("configPackageId", "missing")])
        .send()
        .await
        .unwrap();
    assert!(missing.status().is_client_error());
    fs::remove_file(temp.join("adapter")).unwrap();
    let failed: Value = check("reviewer")
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(failed["status"], "failed");
    assert!(failed["checkedAt"].is_u64());
    assert!(reg.select(None, &json!({})).is_err());
    assert!(reg.lookup("reviewer").is_ok());
    let pi: Value = check("pi")
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(pi["status"], "failed");
    assert_eq!(pi["configured"], false);
    server.abort();
}
