use super::*;
use axum::Router;
use std::{
    fs,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }
    fn store(&self) -> Store {
        Store::open(self.0.clone()).unwrap()
    }
    fn write(&self, relative: &str, bytes: &[u8]) {
        let path = self.0.join(relative);
        if let Some(parent) = path.parent() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)
                .unwrap();
        }
        fs::write(path, bytes).unwrap();
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn sample(requirement: &str, materials: Value) -> Value {
    json!({
        "id": "w1",
        "typeId": "finding-report",
        "requirement": requirement,
        "frozen": false,
        "roles": [{"id":"finding","label":"Finding"},{"id":"source","label":"源码包"}],
        "sop": {"id":"receipt","revision":1,"executor":"echo","config":{"title":"材料接收回执"}},
        "materials": materials,
        "attempts": [],
    })
}

fn material(role: &str, blob: Option<&str>, name: &str) -> Value {
    match blob {
        Some(blob) => json!({"role":role,"name":name,"size":5,"blob":blob}),
        None => json!({"role":role,"name":name,"size":5}),
    }
}

fn both() -> Value {
    json!([
        material("finding", None, "线索.md"),
        material("source", None, "src.zip")
    ])
}

fn insert(store: &Store, detail: Value) {
    store
        .update(|db| {
            db["workspaces"] = json!({"w1": detail});
            Ok(())
        })
        .unwrap();
}

fn detail(store: &Store) -> Value {
    store.read(|db| workspace(db, "w1").cloned()).unwrap()
}

fn receipts(store: &Store) -> Value {
    store
        .read(|db| Ok(db.get("receipts").cloned().unwrap_or(Value::Null)))
        .unwrap()
}

fn last_attempt(detail: &Value) -> Value {
    detail["attempts"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone()
}

fn run_ok(temp: &Temp, store: &Store) -> Value {
    store.update(|db| run(db, temp.0.as_path(), "w1")).unwrap()
}

#[test]
fn receipt_hashes_actual_file_bytes_with_labeled_fnv1a64() {
    let temp = Temp::new();
    let store = temp.store();
    insert(
        &store,
        sample(
            "核实这条线索",
            json!([
                material("finding", Some("7f0c"), "线索.md"),
                material("source", None, "src.zip")
            ]),
        ),
    );
    temp.write("workspace-files/7f0c/finding", b"hello");
    temp.write("workspace-files/w1/source", b"world");

    let detail = run_ok(&temp, &store);
    assert_eq!(detail["frozen"], true);
    let attempt = last_attempt(&detail);
    assert_eq!(attempt["status"], "succeeded");
    assert!(attempt.get("error").is_none());

    let receipts = receipts(&store);
    let receipt = &receipts[attempt["id"].as_str().unwrap()];
    assert_eq!(receipt["workspaceId"], "w1");
    assert_eq!(receipt["attemptId"], attempt["id"]);
    assert_eq!(receipt["typeId"], "finding-report");
    assert_eq!(receipt["title"], "材料接收回执");
    assert_eq!(receipt["sop"]["revision"], 1);
    assert_eq!(
        receipt["materials"][0],
        json!({"role":"finding","label":"Finding","name":"线索.md","size":5,
            "digest":{"algorithm":"fnv1a64","value":"a430d84680aabd0b"}})
    );
    assert_eq!(
        receipt["materials"][1]["digest"]["value"],
        "4f59ff5e730c8af3"
    );
    let text = receipt["text"].as_str().unwrap();
    assert!(text.contains("# 材料接收回执"));
    assert!(text.contains("核实这条线索"));
    assert!(text.contains("FNV-1a64 a430d84680aabd0b"));
    assert!(text.contains("不作为密码学签名"));
}

#[test]
fn any_echo_sop_revision_runs_with_its_own_title() {
    let temp = Temp::new();
    let store = temp.store();
    let mut doc = sample("核实", both());
    doc["sop"] =
        json!({"id":"receipt","revision":2,"executor":"echo","config":{"title":"交接记录"}});
    insert(&store, doc);
    temp.write("workspace-files/w1/finding", b"hello");
    temp.write("workspace-files/w1/source", b"world");
    let done = run_ok(&temp, &store);
    let receipts = receipts(&store);
    let receipt = &receipts[last_attempt(&done)["id"].as_str().unwrap()];
    assert_eq!(receipt["title"], "交接记录");
    assert!(receipt["text"].as_str().unwrap().contains("# 交接记录"));

    let mut doc = sample("核实", both());
    doc["sop"] = json!({"id":"receipt","revision":1,"executor":"shell","config":{"title":"外部"}});
    insert(&store, doc);
    let result = store.update(|db| run(db, temp.0.as_path(), "w1"));
    assert!(matches!(result, Err(Error::Internal(_))));
    assert_eq!(detail(&store)["frozen"], false);
}

#[test]
fn material_blob_directory_wins_over_role_and_hides_upload_name() {
    let temp = Temp::new();
    let store = temp.store();
    insert(
        &store,
        sample(
            "核实",
            json!([
                material("finding", Some("blob-1"), "线索.md"),
                material("source", None, "src.zip")
            ]),
        ),
    );
    temp.write("workspace-files/blob-1/finding", b"hello");
    temp.write("workspace-files/w1/finding", b"world");
    temp.write("workspace-files/w1/source", b"world");

    let detail = run_ok(&temp, &store);
    assert_eq!(last_attempt(&detail)["status"], "succeeded");
    let receipts = receipts(&store);
    let receipt = &receipts[last_attempt(&detail)["id"].as_str().unwrap()];
    assert_eq!(
        receipt["materials"][0]["digest"]["value"],
        "a430d84680aabd0b"
    );
    let text = receipt["text"].as_str().unwrap();
    assert!(text.contains("线索.md"));
    assert!(!text.contains("blob-1"));
    assert!(!text.contains(temp.0.to_str().unwrap()));
}

#[test]
fn missing_role_material_rejects_before_freezing() {
    let temp = Temp::new();
    let store = temp.store();
    insert(
        &store,
        sample("核实", json!([material("finding", None, "线索.md")])),
    );
    temp.write("workspace-files/w1/finding", b"hello");

    let result = store.update(|db| run(db, temp.0.as_path(), "w1"));
    assert!(matches!(&result, Err(Error::Invalid(m)) if m.contains("源码包")));
    let detail = detail(&store);
    assert_eq!(detail["frozen"], false);
    assert_eq!(detail["attempts"], json!([]));
    assert_eq!(receipts(&store), Value::Null);
}

#[test]
fn blank_requirement_rejects_before_freezing() {
    let temp = Temp::new();
    let store = temp.store();
    insert(&store, sample("   \n", both()).clone());

    let result = store.update(|db| run(db, temp.0.as_path(), "w1"));
    assert!(matches!(&result, Err(Error::Invalid(m)) if m.contains("需求")));
    let detail = detail(&store);
    assert_eq!(detail["requirement"], "   \n");
    assert_eq!(detail["frozen"], false);
    assert_eq!(detail["attempts"], json!([]));
}

#[test]
fn unreadable_material_is_recorded_as_failed_attempt_without_paths() {
    let temp = Temp::new();
    let store = temp.store();
    insert(&store, sample("核实", both()));

    let detail = run_ok(&temp, &store);
    assert_eq!(detail["frozen"], true);
    let attempt = last_attempt(&detail);
    assert_eq!(attempt["status"], "failed");
    let error = attempt["error"].as_str().unwrap();
    assert!(!error.contains(temp.0.to_str().unwrap()));
    assert_eq!(receipts(&store), Value::Null);

    // 目录存在但缺少某个角色的文件时，失败信息指出材料角色，仍不暴露路径。
    temp.write("workspace-files/w1/finding", b"hello");
    let detail = run_ok(&temp, &store);
    let attempt = last_attempt(&detail);
    assert_eq!(attempt["status"], "failed");
    let error = attempt["error"].as_str().unwrap();
    assert!(error.contains("源码包"), "{error}");
    assert!(!error.contains(temp.0.to_str().unwrap()));
    assert_eq!(detail["attempts"].as_array().unwrap().len(), 2);
}

#[test]
fn symlinked_material_is_rejected() {
    let temp = Temp::new();
    let store = temp.store();
    insert(&store, sample("核实", both()));
    let outside = temp.0.join("outside.bin");
    fs::write(&outside, b"hello").unwrap();
    fs::create_dir_all(temp.0.join("workspace-files/w1")).unwrap();
    std::os::unix::fs::symlink(&outside, temp.0.join("workspace-files/w1/finding")).unwrap();
    temp.write("workspace-files/w1/source", b"world");

    let detail = run_ok(&temp, &store);
    let attempt = last_attempt(&detail);
    assert_eq!(attempt["status"], "failed");
    assert_eq!(receipts(&store), Value::Null);
}

#[test]
fn unsafe_blob_rejects_instead_of_escaping_the_files_directory() {
    let temp = Temp::new();
    let store = temp.store();
    insert(
        &store,
        sample(
            "核实",
            json!([
                material("finding", Some("../escape"), "线索.md"),
                material("source", None, "src.zip")
            ]),
        ),
    );
    let result = store.update(|db| run(db, temp.0.as_path(), "w1"));
    assert!(matches!(result, Err(Error::Internal(_))));
    assert_eq!(detail(&store)["frozen"], false);
}

#[test]
fn failed_attempt_can_be_rerun_with_a_new_isolated_receipt() {
    let temp = Temp::new();
    let store = temp.store();
    insert(&store, sample("核实", both()));
    let first = run_ok(&temp, &store);
    let first_id = last_attempt(&first)["id"].as_str().unwrap().to_owned();
    assert_eq!(last_attempt(&first)["status"], "failed");

    temp.write("workspace-files/w1/finding", b"hello");
    temp.write("workspace-files/w1/source", b"world");
    let second = run_ok(&temp, &store);
    assert_eq!(second["attempts"].as_array().unwrap().len(), 2);
    assert_eq!(second["frozen"], true);
    let second_attempt = last_attempt(&second);
    assert_eq!(second_attempt["status"], "succeeded");
    assert_ne!(second_attempt["id"], first_id.as_str());
    let receipts = receipts(&store);
    assert!(receipts.get(&first_id).is_none());
    assert_eq!(
        receipts[second_attempt["id"].as_str().unwrap()]["attemptId"],
        second_attempt["id"]
    );
}

#[test]
fn receipt_lookup_requires_the_owning_workspace_and_a_successful_attempt() {
    let temp = Temp::new();
    let store = temp.store();
    insert(&store, sample("核实", both()));
    let failed = run_ok(&temp, &store);
    let failed_id = last_attempt(&failed)["id"].as_str().unwrap().to_owned();
    assert!(matches!(
        store.read(|db| receipt_text(db, "w1", &failed_id)),
        Err(Error::NotFound(_))
    ));

    temp.write("workspace-files/w1/finding", b"hello");
    temp.write("workspace-files/w1/source", b"world");
    let done = run_ok(&temp, &store);
    let id = last_attempt(&done)["id"].as_str().unwrap().to_owned();
    store
        .read(|db| {
            let text = receipt_text(db, "w1", &id)?;
            assert!(text.contains("FNV-1a64"));
            assert!(matches!(
                receipt_text(db, "w2", &id),
                Err(Error::NotFound(_))
            ));
            Ok(())
        })
        .unwrap();
}

async fn serve(router: Router, dir: &Path) -> PathBuf {
    let socket = dir.join(format!("api-{}", Uuid::new_v4()));
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    socket
}

async fn request(socket: &Path, path: &str) -> (String, String) {
    let mut conn = tokio::net::UnixStream::connect(socket).await.unwrap();
    let request = format!("GET {path} HTTP/1.0\r\n\r\n");
    conn.write_all(request.as_bytes()).await.unwrap();
    let mut reply = String::new();
    conn.read_to_string(&mut reply).await.unwrap();
    let (head, body) = reply.split_once("\r\n\r\n").unwrap();
    (head.to_ascii_lowercase(), body.to_owned())
}

#[tokio::test]
async fn receipt_is_plain_text_and_downloadable_as_attachment() {
    let temp = Temp::new();
    let store = temp.store();
    insert(&store, sample("核实", both()));
    temp.write("workspace-files/w1/finding", b"hello");
    temp.write("workspace-files/w1/source", b"world");
    run_ok(&temp, &store);
    let id = last_attempt(&detail(&store))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let socket = serve(routes(store), temp.0.as_path()).await;

    let (head, body) = request(&socket, &format!("/v2/workspaces/w1/attempts/{id}/receipt")).await;
    assert!(head.contains("200 ok"), "{head}");
    assert!(head.contains("content-type: text/plain; charset=utf-8"));
    assert!(!head.contains("content-disposition"));
    assert!(body.contains("FNV-1a64"));

    let (head, body) = request(
        &socket,
        &format!("/v2/workspaces/w1/attempts/{id}/receipt?download=true"),
    )
    .await;
    assert!(head.contains("200 ok"), "{head}");
    assert!(head.contains("content-disposition: attachment; filename=\"receipt.md\""));
    assert!(body.contains("FNV-1a64"));

    let (head, _) = request(&socket, "/v2/workspaces/w1/attempts/missing/receipt").await;
    assert!(head.contains("404"), "{head}");
}
