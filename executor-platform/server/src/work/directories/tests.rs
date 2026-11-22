use super::*;
use serde_json::{Value, json};
use std::{
    fs as host,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    task::JoinHandle,
};
use uuid::Uuid;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        host::create_dir(&root).unwrap();
        host::set_permissions(&root, host::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    fn base(&self) -> PathBuf {
        self.path("work")
    }
    fn directory(&self, id: &str) -> PathBuf {
        self.base().join(fs::ROOT).join(id)
    }
    fn disk_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = host::read_dir(self.base().join(fs::ROOT))
            .unwrap()
            .map(|item| item.unwrap().file_name().into_string().unwrap())
            .collect();
        ids.sort();
        ids
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = host::remove_dir_all(&self.0);
    }
}

struct Http {
    dir: Temp,
    task: JoinHandle<()>,
}
impl Drop for Http {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn encode(path: &str) -> String {
    path.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

impl Http {
    fn new() -> Self {
        let dir = Temp::new();
        let store = Store::open(dir.base()).unwrap();
        Self::start(dir, store)
    }

    fn start(dir: Temp, store: Store) -> Self {
        let app = routes(store.clone()).unwrap();
        let listener = UnixListener::bind(dir.path("http.sock")).unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { dir, task }
    }

    async fn request(&self, method: &str, path: &str, body: &[u8]) -> (u16, Vec<u8>) {
        let mut socket = UnixStream::connect(self.dir.path("http.sock"))
            .await
            .unwrap();
        let head = format!(
            "{method} {path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        let mut request = head.into_bytes();
        request.extend_from_slice(body);
        socket.write_all(&request).await.unwrap();
        let mut response = Vec::new();
        socket.read_to_end(&mut response).await.unwrap();
        let split = response
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .unwrap_or_else(|| panic!("无效响应：{}", String::from_utf8_lossy(&response)));
        let status: u16 = String::from_utf8_lossy(&response[..split])
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        (status, response[split + 4..].to_vec())
    }

    async fn call(&self, method: &str, path: &str, body: Value) -> (u16, Value) {
        let body = if body.is_null() {
            Vec::new()
        } else {
            body.to_string().into_bytes()
        };
        let (status, bytes) = self.request(method, path, &body).await;
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    async fn ok(&self, method: &str, path: &str, body: Value) -> Value {
        let (status, value) = self.call(method, path, body).await;
        assert_eq!(status, 200, "{method} {path}：{value}");
        value
    }

    async fn status(&self, method: &str, path: &str, body: Value) -> u16 {
        self.call(method, path, body).await.0
    }

    async fn create(&self) -> String {
        self.ok("POST", "/v2/directories", json!({})).await["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn base(id: &str) -> String {
        format!("/v2/directories/{id}")
    }

    async fn put(&self, id: &str, path: &str, bytes: &[u8], replace: bool) -> u16 {
        let flag = if replace { "&replace=true" } else { "" };
        self.request(
            "PUT",
            &format!("{}/file?path={}{flag}", Self::base(id), encode(path)),
            bytes,
        )
        .await
        .0
    }

    async fn get(&self, id: &str, path: &str) -> (u16, Vec<u8>) {
        self.request(
            "GET",
            &format!("{}/file?path={}", Self::base(id), encode(path)),
            &[],
        )
        .await
    }
}

#[tokio::test]
async fn create_list_and_detail_only_expose_the_id() {
    let http = Http::new();
    let created = http.ok("POST", "/v2/directories", json!({})).await;
    let id = created["id"].as_str().unwrap();
    assert_eq!(created, json!({"id": id}));

    let root = http.dir.directory(id);
    assert!(root.is_dir());
    assert_eq!(root.metadata().unwrap().permissions().mode() & 0o077, 0);
    assert_eq!(http.dir.disk_ids(), vec![id.to_owned()]);

    let record: Value =
        serde_json::from_slice(&host::read(http.dir.base().join("work.json")).unwrap()).unwrap();
    assert_eq!(record["directories"][id]["id"], id);
    assert_eq!(
        record["directories"][id]["rules"],
        json!({"fixed": [], "json_objects": []})
    );

    assert_eq!(
        http.ok("GET", "/v2/directories", Value::Null).await,
        json!([{"id": id}])
    );
    assert_eq!(
        http.ok("GET", &Http::base(id), Value::Null).await,
        json!({"id": id})
    );
    assert_eq!(
        http.status("GET", "/v2/directories/unknown", Value::Null)
            .await,
        404
    );
    assert_eq!(
        http.status("POST", "/v2/directories", json!({"name": "多余字段"}))
            .await,
        400
    );
}

#[tokio::test]
async fn files_directories_move_and_remove_follow_the_path_contract() {
    let http = Http::new();
    let id = http.create().await;
    let base = Http::base(&id);

    assert_eq!(
        http.put(&id, "正文.txt", "第一版".as_bytes(), false).await,
        204
    );
    assert_eq!(
        http.get(&id, "正文.txt").await,
        (200, "第一版".as_bytes().to_vec())
    );
    assert_eq!(http.put(&id, "正文.txt", b"again", false).await, 409);
    assert_eq!(
        http.put(&id, "正文.txt", "第二版".as_bytes(), true).await,
        204
    );
    assert_eq!(
        http.get(&id, "正文.txt").await,
        (200, "第二版".as_bytes().to_vec())
    );

    assert_eq!(
        http.status("POST", &format!("{base}/dir"), json!({"path": "材料"}))
            .await,
        204
    );
    assert_eq!(http.put(&id, "材料/数据.bin", &[0, 255], false).await, 204);
    assert_eq!(http.get(&id, "材料/数据.bin").await, (200, vec![0, 255]));

    assert_eq!(
        http.ok("GET", &format!("{base}/tree"), Value::Null).await,
        json!([
            {"path": "材料", "kind": "dir"},
            {"path": "材料/数据.bin", "kind": "file", "size": 2},
            {"path": "正文.txt", "kind": "file", "size": 9},
        ])
    );

    assert_eq!(
        http.status(
            "POST",
            &format!("{base}/move"),
            json!({"from": "材料/数据.bin", "to": "数据.bin"})
        )
        .await,
        204
    );
    assert_eq!(http.get(&id, "数据.bin").await, (200, vec![0, 255]));
    assert_eq!(
        http.status(
            "POST",
            &format!("{base}/move"),
            json!({"from": "数据.bin", "to": "正文.txt"})
        )
        .await,
        409
    );
    assert_eq!(
        http.status(
            "POST",
            &format!("{base}/move"),
            json!({"from": "材料", "to": "材料/自身"})
        )
        .await,
        400
    );
    assert_eq!(http.put(&id, "缺少父目录/文件.txt", b"x", false).await, 404);

    assert_eq!(http.get(&id, "../escape").await.0, 400);
    assert_eq!(http.get(&id, "/absolute").await.0, 400);
    assert_eq!(http.get(&id, "材料//数据.bin").await.0, 400);

    assert_eq!(
        http.status(
            "DELETE",
            &format!("{base}/entry?path={}", encode("数据.bin")),
            Value::Null
        )
        .await,
        204
    );
    assert_eq!(
        http.status(
            "DELETE",
            &format!("{base}/entry?path={}", encode("数据.bin")),
            Value::Null
        )
        .await,
        404
    );
    assert_eq!(
        http.status(
            "DELETE",
            &format!("{base}/entry?path={}", encode("材料")),
            Value::Null
        )
        .await,
        204
    );
    assert_eq!(
        http.ok("GET", &format!("{base}/tree"), Value::Null).await,
        json!([{"path": "正文.txt", "kind": "file", "size": 9}])
    );
}

#[tokio::test]
async fn rules_protect_fixed_paths_and_their_ancestors() {
    let dir = Temp::new();
    let store = Store::open(dir.base()).unwrap();
    let http = Http::start(dir, store.clone());
    let id = allocate(
        &store,
        Rules {
            fixed: vec!["技能/固定".into(), "保留/内容".into()],
            json_objects: vec!["配置.json".into()],
        },
        |root| {
            fs::mkdir(root, &["技能".into()])?;
            fs::mkdir(root, &["技能".into(), "固定".into()])?;
            fs::write(root, &["配置.json".into()], br#"{"ok":true}"#, false)?;
            Ok(())
        },
        |_, id| Ok(id.to_owned()),
    )
    .unwrap();
    let base = Http::base(&id);

    // 固定路径本身和它的上级目录都不能移动或删除。
    assert_eq!(
        http.status(
            "DELETE",
            &format!("{base}/entry?path={}", encode("技能")),
            Value::Null
        )
        .await,
        409
    );
    assert_eq!(
        http.status(
            "DELETE",
            &format!("{base}/entry?path={}", encode("技能/固定")),
            Value::Null
        )
        .await,
        409
    );
    assert_eq!(
        http.status(
            "POST",
            &format!("{base}/move"),
            json!({"from": "技能", "to": "其他"})
        )
        .await,
        409
    );
    assert_eq!(
        http.status(
            "POST",
            &format!("{base}/move"),
            json!({"from": "其他", "to": "技能"})
        )
        .await,
        409
    );
    // 用文件占住固定路径的上级目录同样被拒绝。
    assert_eq!(http.put(&id, "保留", b"x", false).await, 409);
    assert_eq!(http.get(&id, "保留").await.0, 404);
    // 固定路径之下的新条目不受限制。
    assert_eq!(
        http.status("POST", &format!("{base}/dir"), json!({"path": "技能/自由"}))
            .await,
        204
    );
    assert_eq!(
        http.status(
            "DELETE",
            &format!("{base}/entry?path={}", encode("技能/自由")),
            Value::Null
        )
        .await,
        204
    );

    // 受 JSON 约束的文件拒绝坏正文，原文件不变。
    assert_eq!(http.put(&id, "配置.json", b"{", true).await, 400);
    assert_eq!(
        http.get(&id, "配置.json").await,
        (200, br#"{"ok":true}"#.to_vec())
    );
    assert_eq!(http.put(&id, "配置.json", b"[]", true).await, 400);
    assert_eq!(http.put(&id, "配置.json", b"{}", true).await, 204);
    assert_eq!(http.get(&id, "配置.json").await, (200, b"{}".to_vec()));

    // 移动到受 JSON 约束的路径同样校验正文，不能绕过写入检查。
    assert_eq!(http.put(&id, "草稿.json", b"[", false).await, 204);
    assert_eq!(
        http.status(
            "DELETE",
            &format!("{base}/entry?path={}", encode("配置.json")),
            Value::Null
        )
        .await,
        204
    );
    assert_eq!(
        http.status(
            "POST",
            &format!("{base}/move"),
            json!({"from": "草稿.json", "to": "配置.json"})
        )
        .await,
        400
    );
    assert_eq!(http.get(&id, "配置.json").await.0, 404);
    assert_eq!(http.put(&id, "正式.json", b"{}", false).await, 204);
    assert_eq!(
        http.status(
            "POST",
            &format!("{base}/move"),
            json!({"from": "正式.json", "to": "配置.json"})
        )
        .await,
        204
    );
    assert_eq!(http.get(&id, "配置.json").await, (200, b"{}".to_vec()));
}

#[test]
fn allocate_seeds_first_then_registers_record_and_caller_row_atomically() {
    let dir = Temp::new();
    let store = Store::open(dir.base()).unwrap();
    let id = allocate(
        &store,
        Rules::default(),
        |root| Ok(fs::write(root, &["seed.txt".into()], b"seed", false)?),
        |db, id| {
            db.as_object_mut()
                .unwrap()
                .insert("probe".into(), json!({"directoryId": id}));
            Ok(id.to_owned())
        },
    )
    .unwrap();

    assert_eq!(
        host::read_to_string(dir.directory(&id).join("seed.txt")).unwrap(),
        "seed"
    );
    store
        .read(|db| {
            assert_eq!(db["directories"][&id]["id"], id);
            assert_eq!(db["probe"]["directoryId"], id);
            Ok(())
        })
        .unwrap();

    let before = dir.disk_ids();
    let failed = allocate::<()>(
        &store,
        Rules::default(),
        |_| Err(Error::Invalid("seed 失败".into())),
        |_, _| Ok(()),
    );
    assert!(failed.is_err());
    assert_eq!(dir.disk_ids(), before);

    let failed = allocate::<()>(
        &store,
        Rules::default(),
        |root| Ok(fs::write(root, &["seed.txt".into()], b"seed", false)?),
        |db, _| {
            db.as_object_mut()
                .unwrap()
                .insert("probe2".into(), json!(true));
            Err(Error::Conflict("登记失败".into()))
        },
    );
    assert!(failed.is_err());
    assert_eq!(dir.disk_ids(), before);
    store
        .read(|db| {
            assert!(db.get("probe2").is_none());
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn symlinks_are_not_a_way_out_of_the_directory_root() {
    let http = Http::new();
    let id = http.create().await;
    let root = http.dir.directory(&id);
    let outside = http.dir.path("outside");
    host::create_dir(&outside).unwrap();
    host::write(outside.join("secret.txt"), b"secret").unwrap();
    symlink(&outside, root.join("链接目录")).unwrap();
    symlink(outside.join("secret.txt"), root.join("链接文件")).unwrap();

    assert_eq!(http.get(&id, "链接目录/secret.txt").await.0, 500);
    assert_eq!(http.get(&id, "链接文件").await.0, 404);
    assert_eq!(
        http.ok("GET", &format!("{}/tree", Http::base(&id)), Value::Null)
            .await,
        json!([])
    );
}

#[test]
fn prepare_rejects_a_shared_directory_root() {
    let dir = Temp::new();
    host::create_dir_all(dir.base()).unwrap();
    host::set_permissions(dir.base(), host::Permissions::from_mode(0o700)).unwrap();
    let root = dir.base().join(fs::ROOT);
    host::create_dir(&root).unwrap();
    host::set_permissions(&root, host::Permissions::from_mode(0o755)).unwrap();
    let store = Store::open(dir.base()).unwrap();
    assert!(routes(store).is_err());
}

#[tokio::test]
async fn frozen_directories_stay_readable_but_refuse_writes_moves_and_removals() {
    let dir = Temp::new();
    let store = Store::open(dir.base()).unwrap();
    let http = Http::start(dir, store.clone());
    let id = allocate(
        &store,
        Rules::default(),
        |root| {
            fs::write(root, &["报告.md".into()], "正文".as_bytes(), false)?;
            fs::mkdir(root, &["证据".into()])?;
            Ok(())
        },
        |_, id| Ok(id.to_owned()),
    )
    .unwrap();
    store
        .update(|db| {
            db[RECORDS][&id]["state"] = json!("frozen");
            Ok(())
        })
        .unwrap();
    let base = Http::base(&id);

    assert_eq!(http.put(&id, "迟到.md", b"x", false).await, 409);
    assert_eq!(http.put(&id, "报告.md", "改".as_bytes(), true).await, 409);
    assert_eq!(
        http.status("POST", &format!("{base}/dir"), json!({"path": "新目录"}))
            .await,
        409
    );
    assert_eq!(
        http.status(
            "POST",
            &format!("{base}/move"),
            json!({"from": "报告.md", "to": "副本.md"})
        )
        .await,
        409
    );
    assert_eq!(
        http.status(
            "DELETE",
            &format!("{base}/entry?path={}", encode("报告.md")),
            Value::Null
        )
        .await,
        409
    );

    // 升级后保留下来的只读目录仍可读取。
    assert_eq!(
        http.get(&id, "报告.md").await,
        (200, "正文".as_bytes().to_vec())
    );
    let tree = json!([
        {"path": "报告.md", "kind": "file", "size": 6},
        {"path": "证据", "kind": "dir"},
    ]);
    assert_eq!(
        http.ok("GET", &format!("{base}/tree"), Value::Null).await,
        tree
    );
}
