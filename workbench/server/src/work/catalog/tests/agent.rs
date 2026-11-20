use super::super::agent;
use super::*;
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink},
    path::Path,
    process::Command,
};

// Re-run this test with a process-local policy, without changing parallel tests' environment.
fn in_policy_process() -> bool {
    if std::env::var_os("URSI_TEST_CATALOG_CHILD").is_none() {
        let temp = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&temp).unwrap();
        let result = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                std::thread::current().name().unwrap(),
                "--nocapture",
            ])
            .env("URSI_TEST_CATALOG_CHILD", "1")
            .env("URSI_PI_POLICY", temp.join("policy"))
            .current_dir(&temp)
            .output()
            .unwrap();
        fs::remove_dir_all(temp).unwrap();
        assert!(
            result.status.success() && String::from_utf8_lossy(&result.stdout).contains("1 passed"),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        return false;
    }
    true
}

fn write_policy() -> &'static str {
    let path = Path::new("policy");
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    // Deliberately noncanonical key order, including objects inside arrays.
    let raw = r#"{"tools":[{"id":"tickets.get","name":"private.lookup","readOnly":true,"token":"tool-secret","url":"https://private.test/mcp","inputSchema":{"type":"object","properties":{"z":{"type":"string","description":"说明"}},"allOf":[{"z":2,"a":1}]}}],"models":[{"id":"managed","provider":{"apiKey":"provider-secret"}}]}"#;
    file.write_all(raw.as_bytes()).unwrap();
    raw
}

#[tokio::test]
async fn private_policy_and_frozen_agent_revisions() {
    if !in_policy_process() {
        return;
    }
    let raw = write_policy();
    let path = Path::new("policy");
    let base = std::env::current_dir().unwrap().join("store");
    let store = Store::open(base.clone()).unwrap();
    let mut body = json!({"id":"agent","resources":[{"id":"guide","revision":1}],"agent":{"systemPrompt":" 固定指令\n","modelProfile":"managed","tools":["tickets.get"]}});
    let snapshot = json!({"systemPrompt":" 固定指令\n","modelProfile":"managed","skills":[{"id":"guide","revision":1,"content":"v1"}],"tools":[{"id":"tickets.get","schemaDigest":"fe8206509685722f4ba8c5225536b6ed16f13d01fae04be19f5650202e4f41d9"}]});
    let published = store
        .update(|db| {
            resource(db, "guide", "skill", "v1".into());
            resource(db, "guide", "skill", "v2".into());
            resource(db, "prompt", "prompt", "prompt".into());
            let before = db.clone();
            assert_eq!(agent_preview(db, &body)?, snapshot);
            assert_eq!(db, &before);
            for (pointer, bad) in [
                ("/agent", json!({})),
                ("/agent/systemPrompt", json!(" ")),
                ("/agent/modelProfile", json!("unknown")),
                ("/agent/tools", json!(["../tool"])),
                ("/agent/tools", json!(["unapproved"])),
                ("/agent/tools", json!(["tickets.get", "tickets.get"])),
                ("/resources", json!([{"id":"prompt","revision":1}])),
                (
                    "/resources",
                    json!([{"id":"guide","revision":1},{"id":"guide","revision":2}]),
                ),
                ("/resources", json!([{"id":"guide","revision":42}])),
            ] {
                let mut invalid = body.clone();
                *invalid.pointer_mut(pointer).unwrap() = bad;
                assert!(publish(db, "executors", invalid).is_err());
            }
            for field in ["command", "env", "provider", "path", "token", "inputSchema"] {
                let mut invalid = body.clone();
                invalid["agent"][field] = json!("injected");
                assert!(matches!(
                    publish(db, "executors", invalid),
                    Err(Error::Invalid(_))
                ));
            }
            assert_eq!(db, &before);
            publish(db, "executors", body.clone())
        })
        .unwrap();
    let mut public = body.clone();
    public["revision"] = json!(1);
    assert_eq!(published, public);
    drop(store);

    let store = Store::open(base.clone()).unwrap();
    fs::write(path, raw.replace("说明", "修改")).unwrap();
    body["resources"][0]["revision"] = json!(2);
    let revised = store
        .update(|db| {
            let revised = agent_preview(db, &body)?;
            assert_ne!(revised["tools"], snapshot["tools"]);
            assert_eq!(publish(db, "executors", body.clone())?["revision"], 2);
            deactivate(db, "resources", "guide")?;
            assert!(matches!(agent_preview(db, &body), Err(Error::Conflict(_))));
            Ok(revised)
        })
        .unwrap();
    fs::remove_file(path).unwrap();
    assert!(matches!(agent::options().await, Err(Error::Unavailable(_))));
    store
        .update(|db| {
            assert_eq!(agent_snapshot(db, "agent", 1)?, snapshot);
            assert_eq!(agent_snapshot(db, "agent", 2)?, revised);
            assert_eq!(version(db, "executors", "agent", 1)?, &public);
            assert_eq!(versions(record(db, "executors", "agent")?)?.len(), 2);
            let mut latest = body.clone();
            latest["active"] = json!(true);
            latest["revision"] = json!(2);
            assert_eq!(list_latest(db, "executors")?, json!([latest]));
            assert!(matches!(
                agent_snapshot(db, "agent", 3),
                Err(Error::NotFound(_))
            ));
            deactivate(db, "executors", "agent")?;
            assert!(matches!(
                agent_snapshot(db, "agent", 1),
                Err(Error::Conflict(_))
            ));
            assert_eq!(version(db, "executors", "agent", 1)?, &public);
            Ok(())
        })
        .unwrap();
    let disk = fs::read_to_string(base.join("work.json")).unwrap();
    for private in [
        "tool-secret",
        "provider-secret",
        "private.lookup",
        "private.test",
        "inputSchema",
    ] {
        assert!(!disk.contains(private));
    }
}

#[tokio::test]
async fn invalid_or_non_private_policy_fails_closed() {
    if !in_policy_process() {
        return;
    }
    let raw = write_policy();
    let path = Path::new("policy");
    for invalid in [
        raw.replace("true", "false"),
        raw.replace("https://private.test/mcp", "file:///etc/file"),
        raw.replace("\"managed\"", "\"../managed\""),
        raw.replace("\"tools\":[", "\"tools\":[{} ,"),
    ] {
        fs::write(path, invalid).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(agent::options().await, Err(Error::Unavailable(_))));
    }
    fs::write(path, raw).unwrap();
    for mode in [0o644, 0o400, 0o700] {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        assert!(matches!(agent::options().await, Err(Error::Unavailable(_))));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::rename(path, "private-policy").unwrap();
    symlink("private-policy", path).unwrap();
    assert!(matches!(agent::options().await, Err(Error::Unavailable(_))));
}

#[tokio::test]
async fn http_exposes_only_ids_and_public_definition() {
    if !in_policy_process() {
        return;
    }
    write_policy();
    let store = Store::open(std::env::current_dir().unwrap().join("work")).unwrap();
    let app = Router::new().nest("/api", routes(store));
    let listen = tokio::net::UnixListener::bind("http.sock").unwrap();
    let server = tokio::spawn(async move { axum::serve(listen, app).await.unwrap() });
    let client = reqwest::Client::builder()
        .unix_socket(Path::new("http.sock"))
        .no_proxy()
        .build()
        .unwrap();
    let url = "http://catalog/api/v2";
    let get = |path: &'static str| {
        let request = client.get(format!("{url}/{path}"));
        async move {
            request
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        }
    };
    assert_eq!(
        get("agent-options").await,
        json!({"models":[{"id":"managed"}],"tools":[{"id":"tickets.get"}]})
    );
    let mut body = json!({"id":"review","agent":{"systemPrompt":"inspect","modelProfile":"managed","tools":[]}});
    let published: Value = client
        .post(format!("{url}/executors"))
        .json(&body)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    body["revision"] = json!(1);
    assert_eq!(published, body);
    assert_eq!(get("executors/review/revisions").await, json!([body]));
    assert_eq!(get("executors/review/revisions/1").await, body);
    body["active"] = json!(true);
    assert_eq!(get("executors").await, json!([body]));
    assert_eq!(get("executors/review").await, body);
    server.abort();
}
