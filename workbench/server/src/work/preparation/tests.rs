use super::*;
use serde_json::{Value, json};
use std::path::PathBuf;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("work-preparation-{}", Uuid::new_v4()));
        DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }
    fn store(&self) -> Store {
        Store::open(self.0.clone()).unwrap()
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn draft(value: Value) -> model::Draft {
    serde_json::from_value(value).unwrap()
}

fn default_draft(requirement: &str) -> model::Draft {
    draft(json!({"typeId":"finding-report","requirement":requirement}))
}

fn edit(requirement: &str) -> model::Edit {
    serde_json::from_value(json!({"requirement":requirement})).unwrap()
}

#[test]
fn create_pins_type_roles_and_type_sop() {
    let mut db = json!({});
    let workspace = model::create(&mut db, default_draft("分析线索 42")).unwrap();
    let id = workspace["id"].as_str().unwrap();
    assert_eq!(workspace["typeId"], "finding-report");
    assert_eq!(workspace["requirement"], "分析线索 42");
    assert_eq!(workspace["frozen"], false);
    assert_eq!(
        workspace["roles"],
        json!([{"id":"finding","label":"Finding"},{"id":"source","label":"源码包"}])
    );
    assert_eq!(
        workspace["sop"],
        json!({"id":"receipt","revision":1,"executor":"echo","config":{"title":"材料接收回执"}})
    );
    assert_eq!(workspace["materials"], json!([]));
    assert_eq!(workspace["attempts"], json!([]));
    assert_eq!(db["workspaces"][id], workspace);
    assert_eq!(model::list(&db).unwrap(), json!([workspace]));
}

#[test]
fn create_rejects_blank_requirement_and_unknown_definitions_without_writing() {
    let mut db = json!({});
    assert!(matches!(
        model::create(&mut db, default_draft("  \n ")),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        model::create(&mut db, draft(json!({"typeId":"other","requirement":"x"}))),
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        model::create(
            &mut db,
            draft(json!({"typeId":"finding-report","requirement":"x",
                "sop":{"id":"receipt","revision":9}}))
        ),
        Err(Error::NotFound(_))
    ));
    assert_eq!(db, json!({}));
}

#[test]
fn create_accepts_an_explicit_sop_revision() {
    let mut db = json!({});
    let workspace = model::create(
        &mut db,
        draft(json!({"typeId":"finding-report","requirement":"x","sop":{"id":"receipt","revision":1}})),
    )
    .unwrap();
    assert_eq!(workspace["sop"]["revision"], 1);
}

#[test]
fn edit_changes_only_the_requirement_and_stops_after_freeze() {
    let mut db = json!({});
    let workspace = model::create(&mut db, default_draft("初稿")).unwrap();
    let id = workspace["id"].as_str().unwrap().to_owned();
    db["workspaces"][&id]["attempts"] = json!([{"id":"a","status":"succeeded"}]);
    let edited = model::edit(
        model::workspace_mut(&mut db, &id).unwrap(),
        edit("补齐线索来源"),
    )
    .unwrap();
    assert_eq!(edited["requirement"], "补齐线索来源");
    assert_eq!(edited["attempts"], json!([{"id":"a","status":"succeeded"}]));
    assert_eq!(edited["materials"], json!([]));
    db["workspaces"][&id]["frozen"] = true.into();
    assert!(matches!(
        model::edit(
            model::workspace_mut(&mut db, &id).unwrap(),
            edit("冻结后改")
        ),
        Err(Error::Conflict(_))
    ));
    assert_eq!(db["workspaces"][&id]["requirement"], "补齐线索来源");
    assert!(matches!(
        model::workspace(&db, "missing"),
        Err(Error::NotFound(_))
    ));
}

#[test]
fn material_slot_takes_each_known_role_once_before_freeze() {
    let mut db = json!({});
    let workspace = model::create(&mut db, default_draft("x")).unwrap();
    let id = workspace["id"].as_str().unwrap().to_owned();
    let doc = model::workspace_mut(&mut db, &id).unwrap();
    assert!(model::material_slot(doc, "finding").is_ok());
    assert!(matches!(
        model::material_slot(doc, "report"),
        Err(Error::Invalid(_))
    ));
    let doc = model::add_material(doc, "finding", "线索.md", 12).unwrap();
    assert_eq!(
        doc["materials"],
        json!([{"role":"finding","name":"线索.md","size":12}])
    );
    let doc = model::workspace_mut(&mut db, &id).unwrap();
    assert!(matches!(
        model::material_slot(doc, "finding"),
        Err(Error::Conflict(_))
    ));
    doc["frozen"] = true.into();
    assert!(matches!(
        model::material_slot(doc, "source"),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn names_and_sizes_are_bounded() {
    for name in ["线索.md", "source.v2.zip", "a b"] {
        assert!(model::plain_name(name), "{name}");
    }
    for name in [
        "",
        ".",
        "..",
        "a/b",
        "../x",
        "a\\b",
        "a\nb",
        &"x".repeat(256),
    ] {
        assert!(!model::plain_name(name), "{name:?}");
    }
    assert!(within_limit(MATERIAL_LIMIT).is_ok());
    assert!(within_limit(0).is_ok());
    assert!(matches!(
        within_limit(MATERIAL_LIMIT + 1),
        Err(Error::Invalid(_))
    ));
}

struct Api {
    socket: PathBuf,
    task: tokio::task::JoinHandle<()>,
}
impl Api {
    fn new(temp: &Temp, store: Store) -> Self {
        let socket = temp.0.join(Uuid::new_v4().to_string());
        let listener = UnixListener::bind(&socket).unwrap();
        let app = routes(store);
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { socket, task }
    }
    async fn stop(self) {
        self.task.abort();
        let _ = self.task.await;
    }
    async fn call(
        &self,
        method: &str,
        path: &str,
        content_type: &str,
        body: &[u8],
    ) -> (u16, Vec<u8>) {
        let mut conn = UnixStream::connect(&self.socket).await.unwrap();
        let head = format!(
            "{method} /v2{path} HTTP/1.0\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        conn.write_all(head.as_bytes()).await.unwrap();
        conn.write_all(body).await.unwrap();
        let mut reply = Vec::new();
        conn.read_to_end(&mut reply).await.unwrap();
        let split = reply.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let status = String::from_utf8_lossy(&reply[..split])
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        (status, reply[split + 4..].to_vec())
    }
    async fn json(&self, method: &str, path: &str, body: Value) -> (u16, Vec<u8>) {
        self.call(
            method,
            path,
            "application/json",
            body.to_string().as_bytes(),
        )
        .await
    }
    async fn create(&self, requirement: &str) -> Value {
        let (status, body) = self
            .json(
                "POST",
                "/workspaces",
                json!({"typeId":"finding-report","requirement":requirement}),
            )
            .await;
        assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
        serde_json::from_slice(&body).unwrap()
    }
}

#[tokio::test]
async fn draft_lifecycle_is_served_over_http() {
    let temp = Temp::new();
    let api = Api::new(&temp, temp.store());
    let workspace = api.create("分析线索 42").await;
    let id = workspace["id"].as_str().unwrap().to_owned();

    let (status, body) = api
        .json("GET", &format!("/workspaces/{id}"), json!(null))
        .await;
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), workspace);

    let (status, body) = api
        .json(
            "PATCH",
            &format!("/workspaces/{id}"),
            json!({"requirement":"补齐来源"}),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["requirement"],
        "补齐来源"
    );

    api.create("线索 43").await;
    let (status, body) = api.json("GET", "/workspaces", json!(null)).await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_slice::<Value>(&body)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let (status, _) = api
        .json(
            "PATCH",
            &format!("/workspaces/{id}"),
            json!({"requirement":" "}),
        )
        .await;
    assert_eq!(status, 400);
    let (status, _) = api.json("GET", "/workspaces/missing", json!(null)).await;
    assert_eq!(status, 404);
    api.stop().await;
}

#[tokio::test]
async fn material_upload_keeps_metadata_and_file_in_step() {
    let temp = Temp::new();
    let store = temp.store();
    let api = Api::new(&temp, store.clone());
    let workspace = api.create("复核 42").await;
    let id = workspace["id"].as_str().unwrap().to_owned();

    let payload = b"PK\x03\x04 source bundle".as_slice();
    let name = "%E6%9D%A5%E6%BA%90.zip";
    let path = format!("/workspaces/{id}/materials/source?name={name}");
    let (status, body) = api
        .call("PUT", &path, "application/octet-stream", payload)
        .await;
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    let workspace: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        workspace["materials"],
        json!([{"role":"source","name":"来源.zip","size":payload.len()}])
    );

    let dir = temp.0.join("workspace-files").join(&id);
    let stored = dir.join("source");
    assert_eq!(fs::read(&stored).unwrap(), payload);
    assert_eq!(
        fs::metadata(&stored).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::symlink_metadata(&dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(!dir.join("来源.zip").exists());

    // 再次上传同一角色不会改动已收存的文件和记录。
    let (status, _) = api
        .call("PUT", &path, "application/octet-stream", b"other")
        .await;
    assert_eq!(status, 409);
    assert_eq!(fs::read(&stored).unwrap(), payload);
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

    api.stop().await;
    drop(store);
    let reopened = temp.store();
    let detail = reopened
        .read(|db| model::workspace(db, &id).cloned())
        .unwrap();
    assert_eq!(detail["materials"], workspace["materials"]);
    assert_eq!(
        fs::read(temp.0.join("workspace-files").join(&id).join("source")).unwrap(),
        payload
    );
}

#[tokio::test]
async fn upload_rejects_bad_roles_and_names() {
    let temp = Temp::new();
    let api = Api::new(&temp, temp.store());
    let workspace = api.create("复核 42").await;
    let id = workspace["id"].as_str().unwrap().to_owned();

    for (role, query) in [
        ("report", "?name=x.md"),
        ("..%2Fetc", "?name=x.md"),
        ("source", ""),
        ("source", "?name="),
        ("source", "?name=..%2Fescape.md"),
        ("source", "?name=a%0Ab.md"),
    ] {
        let path = format!("/workspaces/{id}/materials/{role}{query}");
        let (status, _) = api
            .call("PUT", &path, "application/octet-stream", b"x")
            .await;
        assert_eq!(status, 400, "{path}");
    }
    let dir = temp.0.join("workspace-files").join(&id);
    assert_eq!(fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0), 0);
    api.stop().await;
}

#[tokio::test]
async fn frozen_workspace_refuses_edits_and_uploads() {
    let temp = Temp::new();
    let store = temp.store();
    let api = Api::new(&temp, store.clone());
    let workspace = api.create("复核 42").await;
    let id = workspace["id"].as_str().unwrap().to_owned();
    store
        .update(|db| {
            model::workspace_mut(db, &id).unwrap()["frozen"] = true.into();
            Ok(())
        })
        .unwrap();

    let (status, _) = api
        .json(
            "PATCH",
            &format!("/workspaces/{id}"),
            json!({"requirement":"改需求"}),
        )
        .await;
    assert_eq!(status, 409);
    let (status, _) = api
        .call(
            "PUT",
            &format!("/workspaces/{id}/materials/finding?name=x.md"),
            "application/octet-stream",
            b"x",
        )
        .await;
    assert_eq!(status, 409);
    let (status, body) = api
        .json("GET", &format!("/workspaces/{id}"), json!(null))
        .await;
    assert_eq!(status, 200);
    let detail: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(detail["requirement"], "复核 42");
    assert_eq!(detail["materials"], json!([]));
    assert_eq!(detail["frozen"], true);
    api.stop().await;
}
