use super::super::agent;
use super::*;
use crate::work::{directories, patches};
use std::{
    fs,
    io::Write,
    os::unix::{
        ffi::OsStringExt,
        fs::{OpenOptionsExt, PermissionsExt, symlink},
    },
    path::{Path, PathBuf},
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
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open("policy")
        .unwrap();
    // Default is declaration order, deliberately different from sorted order.
    let raw = r#"{"tools":[{"id":"tickets.get","name":"private.lookup","readOnly":true,"token":"tool-secret","url":"https://private.test/mcp","inputSchema":{"type":"object","properties":{"z":{"type":"string","description":"说明"}},"allOf":[{"z":2,"a":1}]}}],"models":[{"id":"managed","provider":{"apiKey":"provider-secret"}},{"id":"alternate","provider":{}}]}"#;
    file.write_all(raw.as_bytes()).unwrap();
    raw
}

fn package(store: &Store) -> (Value, PathBuf) {
    let root = directories::allocate(
        store,
        Default::default(),
        |root| {
            fs::write(root.join("AGENTS.md"), " 固定指令\n").unwrap();
            fs::create_dir_all(root.join("skills/guide/templates")).unwrap();
            fs::write(root.join("skills/guide/SKILL.md"), "v1").unwrap();
            fs::write(root.join("skills/guide/templates/example"), [0xff]).unwrap();
            fs::write(root.join("skills/flat.md"), [0xff]).unwrap();
            fs::write(root.join("mcp.json"), r#"{"mcpServers":{}}"#).unwrap();
            Ok(())
        },
        |db, id| {
            db["configPatches"]["package"] = json!({"id":"package","directoryId":id});
            db["workPatches"]["work"] = json!({"id":"work","directoryId":id});
            Ok(store.dir().join(directories::fs::ROOT).join(id))
        },
    )
    .unwrap();
    (
        json!({"id":"agent","agent":{"configPackageId":"package"}}),
        root,
    )
}

fn registry(bin: &str) -> Registry {
    Registry::for_test(vec![(
        Entry {
            id: "managed-adapter".into(),
            bin: bin.into(),
            policy: "/private/policy".into(),
        },
        true,
    )])
}

fn commit(store: &Store, body: &Value) -> Result<Value, Error> {
    store.update(|db| {
        super::super::publish(
            store.dir(),
            db,
            "executors",
            body.clone(),
            &registry("/private/adapter"),
        )
    })
}

#[test]
fn private_policy_and_frozen_agent_revisions() {
    if !in_policy_process() {
        return;
    }
    let raw = write_policy();
    let base = std::env::current_dir().unwrap().join("store");
    let store = Store::open(base.clone()).unwrap();
    let (body, root) = package(&store);
    let guide = root.join("skills/guide");
    fs::write(guide.join("templates/SKILL.md"), "nested").unwrap();
    fs::write(guide.join("example"), "").unwrap();
    fs::write(guide.join(".workbench-tmp-ignored"), "temporary").unwrap();
    fs::create_dir_all(root.join("skills/bare/empty")).unwrap();
    fs::write(root.join("skills/bare/SKILL.md"), "no attachments").unwrap();
    let first = json!({"systemPrompt":" 固定指令\n","modelProfile":"managed","skills":[
        {"id":"bare","revision":1,"content":"no attachments"},
        {"id":"guide","revision":1,"content":"v1","files":[
            {"path":"example","contentBase64":"","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
            {"path":"templates/SKILL.md","contentBase64":"bmVzdGVk","sha256":"233562de1a0288b139c4fa40b7d189f806e906eeb048517aeb67f34ac0e2faf1"},
            {"path":"templates/example","contentBase64":"/w==","sha256":"a8100ae6aa1940d0b663bb31cd466142ebbdbd5187131b92d93818987832eb89"}
        ]}
    ],"tools":[]});
    let before = store.read(|db| Ok(db.clone())).unwrap();
    assert_eq!(agent_preview(&store, &body).unwrap(), first);
    assert_eq!(store.read(|db| Ok(db.clone())).unwrap(), before);
    let published = commit(&store, &body).unwrap();
    assert_eq!(published["revision"], 1);
    assert_eq!(published["agent"]["backendId"], "managed-adapter");
    drop(store);
    let store = Store::open(base.clone()).unwrap();
    fs::write(root.join("AGENTS.md"), "new prompt").unwrap();
    fs::write(guide.join("SKILL.md"), "v2").unwrap();
    fs::write(guide.join("templates/example"), [0]).unwrap();
    fs::remove_file(guide.join("templates/SKILL.md")).unwrap();
    fs::remove_file(guide.join("example")).unwrap();
    fs::remove_dir_all(root.join("skills/bare")).unwrap();
    fs::write(
        root.join("mcp.json"),
        r#"{"modelProfile":"alternate","tools":["tickets.get"]}"#,
    )
    .unwrap();
    let second = json!({"systemPrompt":"new prompt","modelProfile":"alternate","skills":[
        {"id":"guide","revision":1,"content":"v2","files":[
            {"path":"templates/example","contentBase64":"AA==","sha256":"6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d"}
        ]}
    ],"tools":[{"id":"tickets.get","schemaDigest":"fe8206509685722f4ba8c5225536b6ed16f13d01fae04be19f5650202e4f41d9"}]});
    assert_eq!(agent_preview(&store, &body).unwrap(), second);
    assert_eq!(commit(&store, &body).unwrap()["revision"], 2);
    fs::write("policy", raw.replace("说明", "修改")).unwrap();
    assert_ne!(
        agent_preview(&store, &body).unwrap()["tools"],
        second["tools"]
    );
    fs::remove_dir_all(root).unwrap();
    assert_eq!(
        published_agent(&store, &registry("/private/adapter"), "agent", 1)
            .unwrap()
            .1,
        first
    );
    assert!(matches!(
        published_agent(&store, &registry("/private/replacement"), "agent", 1),
        Err(Error::Unavailable(_))
    ));
    store
        .update(|db| {
            assert_eq!(agent_snapshot(db, "agent", 1)?, first);
            assert_eq!(agent_snapshot(db, "agent", 2)?, second);
            assert!(matches!(
                agent_snapshot(db, "agent", 3),
                Err(Error::NotFound(_))
            ));
            deactivate(db, "executors", "agent")?;
            assert!(matches!(
                agent_snapshot(db, "agent", 1),
                Err(Error::Conflict(_))
            ));
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

#[test]
fn invalid_package_and_inline_inputs_never_publish() {
    if !in_policy_process() {
        return;
    }
    write_policy();
    let store = Store::open(std::env::current_dir().unwrap().join("work")).unwrap();
    let (body, root) = package(&store);
    let reject = |invalid: &Value| {
        assert!(agent_preview(&store, invalid).is_err());
        assert!(commit(&store, invalid).is_err());
    };
    for id in [
        "../escape",
        "unknown",
        "work",
        root.file_name().unwrap().to_str().unwrap(),
    ] {
        reject(&json!({"id":"agent","agent":{"configPackageId":id}}));
    }
    for invalid in [
        json!({"id":"agent","agent":{"systemPrompt":"inline","modelProfile":"managed","tools":[]}}),
        json!({"id":"agent","agent":body["agent"],"resources":[]}),
        json!({"id":"agent","agent":{"configPackageId":"package","tools":[]}}),
        json!({"id":"agent","agent":{"configPackageId":42}}),
        json!({"id":"agent","agent":{"configPackageId":"package","backendId":null}}),
        json!({"id":"agent","agent":{"configPackageId":"package","backendId":"../adapter"}}),
    ] {
        reject(&invalid);
    }
    for bad in [
        "{",
        "[]",
        "null",
        r#"{"modelProfile":null}"#,
        r#"{"modelProfile":"unknown"}"#,
        r#"{"tools":["unapproved"]}"#,
        r#"{"tools":["tickets.get","tickets.get"]}"#,
        r#"{"tools":null}"#,
        r#"{"tools":[{"command":"echo"}]}"#,
        r#"{"command":"run"}"#,
        r#"{"mcpServers":null}"#,
        r#"{"mcpServers":{"x":{"command":"run"}},"mcpServers":{}}"#,
    ] {
        fs::write(root.join("mcp.json"), bad).unwrap();
        reject(&body);
    }
    fs::write(
        root.join("mcp.json"),
        r#"{"mcpServers":{"x":{"command":"run"}}}"#,
    )
    .unwrap();
    assert!(
        matches!(commit(&store, &body), Err(Error::Invalid(m)) if m.contains("不支持非空 mcpServers"))
    );
    fs::write(root.join("mcp.json"), "{}").unwrap();
    let skill = root.join("skills/guide/SKILL.md");
    for bad in [vec![0xff], vec![], vec![b'a'; 256 * 1024 + 1]] {
        fs::write(&skill, bad).unwrap();
        reject(&body);
    }
    fs::remove_file(&skill).unwrap();
    reject(&body);
    let outside = store.dir().join("outside");
    fs::write(&outside, "not a package document").unwrap();
    symlink(&outside, &skill).unwrap();
    reject(&body);
    fs::remove_file(&skill).unwrap();
    fs::hard_link(&outside, &skill).unwrap();
    reject(&body);
    fs::remove_file(&skill).unwrap();
    fs::write(&skill, "ok").unwrap();
    fs::write(root.join("AGENTS.md"), " \n").unwrap();
    reject(&body);
    fs::write(root.join("AGENTS.md"), "ok").unwrap();
    assert_eq!(commit(&store, &body).unwrap()["revision"], 1);
}

#[test]
fn invalid_skill_attachments_never_publish() {
    if !in_policy_process() {
        return;
    }
    write_policy();
    let store = Store::open(std::env::current_dir().unwrap().join("work")).unwrap();
    let (body, root) = package(&store);
    let nested = root.join("skills/guide/templates");
    let outside = store.dir().join("outside");
    fs::create_dir(&outside).unwrap();
    let outside_file = outside.join("secret");
    fs::write(&outside_file, "not in the package").unwrap();
    let reject = || {
        assert!(matches!(
            agent_preview(&store, &body),
            Err(Error::Invalid(_))
        ));
        assert!(matches!(commit(&store, &body), Err(Error::Invalid(_))));
    };
    let entry = nested.join("bad");
    for target in [&outside_file, &outside, &nested.join("example")] {
        symlink(target, &entry).unwrap();
        reject();
        fs::remove_file(&entry).unwrap();
    }
    fs::hard_link(&outside_file, &entry).unwrap();
    reject();
    fs::remove_file(&entry).unwrap();
    rustix::fs::mknodat(
        rustix::fs::CWD,
        &entry,
        rustix::fs::FileType::Fifo,
        rustix::fs::Mode::RUSR,
        0,
    )
    .unwrap();
    reject();
    fs::remove_file(&entry).unwrap();
    for bad in [b"bad\nname".to_vec(), vec![0xff]] {
        let entry = nested.join(std::ffi::OsString::from_vec(bad));
        fs::write(&entry, "bad path").unwrap();
        reject();
        fs::remove_file(&entry).unwrap();
    }
    let deep = nested.join("d/".repeat(30));
    fs::create_dir_all(&deep).unwrap();
    reject();
    fs::remove_dir_all(nested.join("d")).unwrap();
    let long = nested.join(format!("{0}/{0}/{0}/{0}", "x".repeat(255)));
    fs::create_dir_all(&long).unwrap();
    reject();
    fs::remove_dir_all(nested.join("x".repeat(255))).unwrap();
    let many = nested.join("many");
    fs::create_dir(&many).unwrap();
    for i in 0..4096 {
        fs::create_dir(many.join(i.to_string())).unwrap();
    }
    reject();
    fs::remove_dir_all(many).unwrap();
    assert_eq!(commit(&store, &body).unwrap()["revision"], 1);
}

#[test]
fn skill_attachments_count_toward_serialized_snapshot_limit() {
    if !in_policy_process() {
        return;
    }
    write_policy();
    let store = Store::open(std::env::current_dir().unwrap().join("work")).unwrap();
    let (body, root) = package(&store);
    let first = root.join("skills/guide/templates/example");
    let second = root.join("skills/guide/other");
    let prompt = root.join("AGENTS.md");
    let baseline_prompt = "x";
    fs::write(&prompt, baseline_prompt).unwrap();
    for path in [&first, &second] {
        fs::write(path, "").unwrap();
    }
    let overhead = agent_preview(&store, &body).unwrap().to_string().len();
    let available = agent::SNAPSHOT_LIMIT - overhead;
    // Two attachments are individually within the limit, and Base64 adds four
    // bytes per three raw bytes. Pad the prompt to reach the exact JSON boundary.
    let groups = available / 4;
    fs::write(&first, vec![0; groups / 2 * 3]).unwrap();
    fs::write(&second, vec![0; (groups - groups / 2) * 3]).unwrap();
    fs::write(&prompt, "x".repeat(1 + available % 4)).unwrap();
    assert_eq!(
        agent_preview(&store, &body).unwrap().to_string().len(),
        agent::SNAPSHOT_LIMIT
    );
    fs::write(&prompt, "x".repeat(2 + available % 4)).unwrap();
    assert!(matches!(agent_preview(&store, &body), Err(Error::Invalid(m)) if m.contains("2 MiB")));
    assert!(matches!(commit(&store, &body), Err(Error::Invalid(m)) if m.contains("2 MiB")));
    // A single oversized attachment also fails before its contents are read.
    fs::File::options()
        .write(true)
        .open(first)
        .unwrap()
        .set_len(directories::fs::FILE_LIMIT + 1)
        .unwrap();
    assert!(matches!(agent_preview(&store, &body), Err(Error::Invalid(m)) if m.contains("2 MiB")));
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
    let app = routes(store.clone(), registry("/private/adapter"))
        .merge(patches::routes(store.clone()))
        .merge(directories::routes(store).unwrap());
    let listen = tokio::net::UnixListener::bind("http.sock").unwrap();
    let server = tokio::spawn(async move { axum::serve(listen, app).await.unwrap() });
    let client = reqwest::Client::builder()
        .unix_socket(Path::new("http.sock"))
        .no_proxy()
        .build()
        .unwrap();
    let url = "http://catalog/v2";
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
        json!({"models":[{"id":"managed"},{"id":"alternate"}],"tools":[{"id":"tickets.get"}]})
    );
    let package: Value = client
        .post(format!("{url}/patches/config"))
        .json(&json!({"name":"测试"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    client
        .put(format!(
            "{url}/directories/{}/file?path=AGENTS.md&replace=true",
            package["directoryId"].as_str().unwrap()
        ))
        .body("private prompt")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let mut body = json!({"id":"review","agent":{"configPackageId":package["id"]}});
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
    body["agent"]["backendId"] = "managed-adapter".into();
    assert_eq!(published, body);
    assert_eq!(get("executors/review/revisions").await, json!([body]));
    assert_eq!(get("executors/review/revisions/1").await, body);
    body["active"] = json!(true);
    assert_eq!(get("executors").await, json!([body]));
    assert_eq!(get("executors/review").await, body);
    server.abort();
}
