use super::*;

struct Fixture {
    temp: Temp,
    store: Store,
    cfg: sandbox::Config,
    local: PathBuf,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let temp = Temp::new();
        let store = Store::open(temp.0.join("db")).unwrap();
        let mut i = item();
        i["packageSnapshot"]["actions"]["analyze"]["executor"]["environment"] = "sandbox".into();
        store
            .update(|db| {
                db["items"] = json!({"i":i,"other":i});
                Ok(())
            })
            .unwrap();
        let token_file = temp.0.join("session-token");
        fs::write(&token_file, "fixture").unwrap();
        fs::set_permissions(&token_file, fs::Permissions::from_mode(0o600)).unwrap();
        let bin = temp.executable("acp-cli", include_str!("fake_acp.py"));
        let cfg = sandbox::Config {
            bin,
            token_file,
            url: "ws://localhost:8765/acp".into(),
            cwd: "/ursi/workspace/private".into(),
            alias: "case-i".into(),
            item: "i".into(),
        };
        fs::write(temp.0.join("mode"), mode).unwrap();
        let local = temp.script("touch local-fallback");
        Self {
            temp,
            store,
            cfg,
            local,
        }
    }
    fn api(&self) -> Api {
        Api::configured(
            &self.temp,
            self.store.clone(),
            self.local.clone(),
            Some(self.cfg.clone()),
        )
    }
}
const ATTEMPTS: &str = "items/i/attempts";
fn request() -> Value {
    json!({"action":"analyze"})
}
async fn settled(api: &Api, path: &str) -> Value {
    tokio::time::timeout(READY_LIMIT, async {
        loop {
            let a = api.request(path, None, 200).await;
            if !matches!(a["status"].as_str(), Some("starting" | "running")) {
                return a;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn sandbox_new_persists_before_prompt_and_enforces_item_and_permissions() {
    let f = Fixture::new("complete");
    let api = f.api();
    fs::set_permissions(&f.cfg.token_file, fs::Permissions::from_mode(0o644)).unwrap();
    api.request(ATTEMPTS, Some(request()), 503).await;
    fs::set_permissions(&f.cfg.token_file, fs::Permissions::from_mode(0o600)).unwrap();
    api.request("items/other/attempts", Some(request()), 503)
        .await;
    let a = api.post(ATTEMPTS, request()).await;
    assert_eq!(a["backendRunId"], Value::Null);
    let a = settled(&api, &format!("{ATTEMPTS}/{}", a["id"].as_str().unwrap())).await;
    assert_eq!(a["status"], "succeeded");
    assert_eq!(a["output"], "answer:[sandbox]");
    assert!(f.temp.0.join("closed").exists());
    drop(api);
    let absent = Api::new(&f.temp, f.store.clone(), f.local.clone());
    absent.request(ATTEMPTS, Some(request()), 503).await;
    assert!(!f.temp.0.join("local-fallback").exists());
    let mut historical_alias = f.cfg.clone();
    historical_alias.item = "other".into();
    assert!(
        f.store
            .read(|db| historical_alias.reserve(db, "other"))
            .is_err()
    );
}

#[tokio::test]
async fn sandbox_cancel_requires_original_turn_and_matching_stopped_session() {
    for (mode, code, status) in [
        ("cancel", 200, "cancelled"),
        ("wrong-status", 409, "unverified"),
        ("ack-only", 409, "unverified"),
    ] {
        let f = Fixture::new(mode);
        let api = f.api();
        let a = api.post(ATTEMPTS, request()).await;
        let path = format!("{ATTEMPTS}/{}", a["id"].as_str().unwrap());
        wait_file(&f.temp.0.join("count")).await;
        api.request(ATTEMPTS, Some(request()), 409).await;
        api.request(&format!("{path}/cancel"), Some(json!({})), code)
            .await;
        assert_eq!(api.request(&path, None, 200).await["status"], status);
        assert_eq!(
            fs::read_to_string(f.temp.0.join("count")).unwrap(),
            "prompt\n"
        );
    }
}

#[tokio::test]
async fn sandbox_uncertain_turn_holds_slot_until_evidenced_close_after_restart() {
    let f = Fixture::new("disconnect");
    let api = f.api();
    let a = api.post(ATTEMPTS, request()).await;
    let path = format!("{ATTEMPTS}/{}", a["id"].as_str().unwrap());
    assert_eq!(settled(&api, &path).await["status"], "unverified");
    drop(api);
    let api = f.api();
    let evidence = json!({"status":"failed","reason":"任务未交付","evidence":"管理员收尾记录 #42"});
    let verify = format!("{path}/verify");
    api.request(&verify, Some(evidence.clone()), 409).await;
    api.request(ATTEMPTS, Some(request()), 409).await;
    fs::write(f.temp.0.join("closed"), "").unwrap();
    assert_eq!(api.post(&verify, evidence).await["status"], "failed");
    assert_eq!(
        fs::read_to_string(f.temp.0.join("count")).unwrap(),
        "prompt\n"
    );
    assert!(f.store.read(|db| f.cfg.reserve(db, "i")).is_ok());
}
