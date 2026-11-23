use super::directories::fs as dir;
use super::*;
use dir::Fault;
use serde_json::{Value, json};
use std::{
    fs,
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
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    /// 包私有根，与 requests 使用的布局一致。
    fn package(&self, id: &str) -> PathBuf {
        self.path("work").join("directories").join(id)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Http {
    dir: Temp,
    store: Store,
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
        Self::open(Temp::new())
    }

    fn open(dir: Temp) -> Self {
        let store = Store::open(dir.path("work")).unwrap();
        let app = crate::work::business_directories::routes(store.clone())
            .unwrap()
            .merge(routes_with_platform(store.clone(), None))
            .merge(worklist::routes(store.clone()));
        let listener = UnixListener::bind(dir.path("http.sock")).unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { dir, store, task }
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

    async fn create(&self, name: &str) -> String {
        let patch = self
            .ok("POST", "/v2/patches/work", json!({"name":name}))
            .await;
        assert_ne!(patch["id"], patch["directoryId"]);
        patch["directoryId"].as_str().unwrap().to_owned()
    }

    fn base(id: &str) -> String {
        format!("/v2/directories/{id}")
    }

    async fn tree(&self, id: &str) -> Vec<Value> {
        self.ok("GET", &format!("{}/tree", Self::base(id)), Value::Null)
            .await
            .as_array()
            .unwrap()
            .clone()
    }

    async fn paths(&self, id: &str) -> Vec<String> {
        let mut paths: Vec<String> = self
            .tree(id)
            .await
            .iter()
            .map(|entry| entry["path"].as_str().unwrap().to_owned())
            .collect();
        paths.sort();
        paths
    }

    fn file_url(id: &str, path: &str, replace: bool) -> String {
        format!(
            "{}/file?path={}{}",
            Self::base(id),
            encode(path),
            if replace { "&replace=true" } else { "" }
        )
    }

    async fn put(&self, id: &str, path: &str, bytes: &[u8], replace: bool) -> u16 {
        self.request("PUT", &Self::file_url(id, path, replace), bytes)
            .await
            .0
    }

    async fn get(&self, id: &str, path: &str) -> (u16, Vec<u8>) {
        self.request("GET", &Self::file_url(id, path, false), b"")
            .await
    }

    async fn mkdir(&self, id: &str, path: &str) -> u16 {
        self.call(
            "POST",
            &format!("{}/dir", Self::base(id)),
            json!({"path":path}),
        )
        .await
        .0
    }

    async fn relocate(&self, id: &str, from: &str, to: &str) -> u16 {
        self.call(
            "POST",
            &format!("{}/move", Self::base(id)),
            json!({"from":from,"to":to}),
        )
        .await
        .0
    }

    async fn remove(&self, id: &str, path: &str) -> u16 {
        self.call(
            "DELETE",
            &format!("{}/entry?path={}", Self::base(id), encode(path)),
            Value::Null,
        )
        .await
        .0
    }
}

#[tokio::test]
async fn lists_work_packages_and_rejects_bad_input() {
    let app = Http::new();
    assert_eq!(
        app.ok("GET", "/v2/patches/work", Value::Null).await,
        json!([])
    );
    let work = app.create("  结算异常排查  ").await;
    let listed = app.ok("GET", "/v2/patches/work", Value::Null).await;
    let work_id = listed[0]["id"].as_str().unwrap();
    assert_ne!(work_id, work);
    let created = listed[0]["createdAt"].as_u64().unwrap();
    assert!(
        created > 0
            && created
                <= SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs()
    );
    assert_eq!(
        listed,
        json!([{"id":work_id,"name":"结算异常排查","directoryId":work,
        "source":"manual","createdAt":created,"executionStatus":"not_started","workItemId":null}])
    );
    assert_eq!(
        app.ok("GET", &format!("/v2/patches/work/{work_id}"), Value::Null)
            .await,
        listed[0]
    );
    assert_eq!(
        app.call("GET", &format!("/v2/directories/{work_id}"), Value::Null)
            .await
            .0,
        404
    );
    assert_eq!(
        app.call("GET", &format!("/v2/patches/config/{work_id}"), Value::Null)
            .await
            .0,
        404
    );
    assert_eq!(
        app.call("GET", "/v2/patches/other", Value::Null).await.0,
        404
    );
    assert_eq!(
        app.call("POST", "/v2/patches/work", json!({"name":""}))
            .await
            .0,
        400
    );
    assert_eq!(
        app.call("POST", "/v2/patches/work", json!({"name":"x".repeat(81)}))
            .await
            .0,
        400
    );
    assert_eq!(
        app.call(
            "POST",
            "/v2/patches/work",
            json!({"name":"ok","kind":"config"})
        )
        .await
        .0,
        422
    );
    assert_eq!(
        app.call(
            "GET",
            &format!("/v2/patches/work/{}/tree", Uuid::new_v4()),
            Value::Null
        )
        .await
        .0,
        404
    );
    // 失败不建立记录，列表仍只有一个包。
    assert_eq!(
        app.ok("GET", "/v2/patches/work", Value::Null)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn work_item_recipe_endpoint_is_gone_and_requests_stay_clean() {
    let app = Http::new();
    let item = app
        .ok("POST", "/v2/work-items", json!({"title":"账单"}))
        .await;
    let path = format!("/v2/work-items/{}", item["id"].as_str().unwrap());
    assert_eq!(
        app.call("POST", &format!("{path}/generate"), json!({"requestId":"one-click"}))
            .await
            .0,
        404
    );
    for list in ["/v2/patches/work", "/v2/directories"] {
        assert_eq!(app.ok("GET", list, Value::Null).await, json!([]));
    }
    assert!(
        app.store
            .read(|db| Ok(db.get("workListGenerations").is_none()))
            .unwrap()
    );
}

#[tokio::test]
async fn binds_moves_and_detaches_only_work_packages() {
    let app = Http::new();
    let a = app
        .ok("POST", "/v2/work-items", json!({"title":"甲"}))
        .await;
    let b = app
        .ok("POST", "/v2/work-items", json!({"title":"乙"}))
        .await;
    let created = app
        .ok(
            "POST",
            "/v2/patches/work",
            json!({"name":"材料","workItemId":a["id"]}),
        )
        .await;
    let path = format!("/v2/patches/work/{}", created["id"].as_str().unwrap());
    assert_eq!(created["workItemId"], a["id"]);
    assert_eq!(app.call("PATCH", &path, json!({})).await.0, 422);
    assert_eq!(
        app.call("PATCH", &path, json!({"workItemId":"missing"}))
            .await
            .0,
        404
    );
    assert_eq!(app.ok("GET", &path, Value::Null).await, created);
    assert_eq!(
        app.call(
            "POST",
            "/v2/patches/work",
            json!({"name":"未知项","workItemId":"missing"})
        )
        .await
        .0,
        404
    );
    assert_eq!(
        app.ok("PATCH", &path, json!({"workItemId":null})).await["workItemId"],
        Value::Null
    );
    assert_eq!(
        app.ok("PATCH", &path, json!({"workItemId":b["id"]})).await["workItemId"],
        b["id"]
    );
    let dir = created["directoryId"].as_str().unwrap();
    assert_eq!(
        app.put(dir, "data", b"immutable reference", false).await,
        204
    );
    let item_url = |v: &Value| format!("/v2/work-items/{}", v["id"].as_str().unwrap());
    assert_eq!(app.call("DELETE", &item_url(&a), Value::Null).await.0, 204);
    assert_eq!(
        app.ok("GET", &path, Value::Null).await["workItemId"],
        b["id"]
    );
    assert_eq!(app.call("DELETE", &item_url(&b), Value::Null).await.0, 204);
    let mut expected = created.clone();
    expected["workItemId"] = Value::Null;
    assert_eq!(app.ok("GET", &path, Value::Null).await, expected);
    assert_eq!(app.get(dir, "data").await.1, b"immutable reference");
}

#[tokio::test]
async fn manual_work_directory_starts_empty_and_has_no_anchors() {
    let app = Http::new();
    let work = app.create("空包").await;
    assert_eq!(app.paths(&work).await, Vec::<String>::new());
    assert_eq!(app.put(&work, "AGENTS.md", b"x", false).await, 204);
    assert_eq!(app.mkdir(&work, "skills").await, 204);
    assert_eq!(app.relocate(&work, "AGENTS.md", "prompt.md").await, 204);
    assert_eq!(app.remove(&work, "skills").await, 204);
}

#[tokio::test]
async fn hides_only_legacy_platform_directories_after_reopening_store() {
    let dir = Temp::new();
    let store = Store::open(dir.path("work")).unwrap();
    let allocate = || {
        directories::allocate(
            &store,
            directories::Rules::default(),
            |root| Ok(dir::write(root, &["file".into()], b"old", false)?),
            |_, id| Ok(id.to_owned()),
        )
        .unwrap()
    };
    let config = allocate();
    let artifact = allocate();
    let visible = allocate();
    store
        .update(|db| {
            db["configPatches"]["old-config"] = json!({"id":"old-config","directoryId":config});
            db["executorAttempts"]["old-run"] = json!({"result":{"artifactDirectoryId":artifact}});
            db["executorAttempts"]["still-running"] = json!({"result":{"status":"running"}});
            // 其它业务路径也可持有冻结目录，不能把冻结状态当作旧平台的归属标志。
            directories::freeze(db, &visible)
        })
        .unwrap();
    drop(store);
    let app = Http::open(dir);
    for id in [&config, &artifact] {
        let path = Http::base(id);
        for suffix in ["", "/tree", "/file?path=file"] {
            assert_eq!(
                app.request("GET", &format!("{path}{suffix}"), b"").await.0,
                404
            );
        }
        let encoded = format!("%{:02X}{}", id.as_bytes()[0], &id[1..]);
        assert_eq!(app.put(&encoded, "file", b"new", true).await, 404);
        assert_eq!(app.mkdir(id, "dir").await, 404);
        assert_eq!(app.relocate(id, "file", "other").await, 404);
        assert_eq!(app.remove(id, "file").await, 404);
        assert_eq!(fs::read(app.dir.package(id).join("file")).unwrap(), b"old");
    }
    assert_eq!(
        app.call("GET", "/v2/patches/config", Value::Null).await.0,
        404
    );
    for id in ["old-config", "unknown"] {
        assert_eq!(
            app.call(
                "POST",
                "/v2/patches/work",
                json!({"name":"x","configPackage":{"id":id}})
            )
            .await
            .0,
            400
        );
    }
    assert_eq!(
        app.ok("GET", "/v2/patches/work", Value::Null).await,
        json!([])
    );
    assert_eq!(
        app.ok("GET", "/v2/directories", Value::Null).await,
        json!([{"id":visible}])
    );
    assert_eq!(app.get(&visible, "file").await, (200, b"old".to_vec()));
    assert_eq!(app.put(&visible, "file", b"new", true).await, 409);
    let work = app.create("业务材料").await;
    let standalone = app.ok("POST", "/v2/directories", json!({})).await;
    let list = app.ok("GET", "/v2/directories", Value::Null).await;
    let rows = list.as_array().unwrap();
    assert_eq!(rows.len(), 3);
    for id in [work.as_str(), standalone["id"].as_str().unwrap()] {
        assert!(rows.contains(&json!({"id":id})));
        assert_eq!(app.put(id, "business", b"ok", false).await, 204);
        assert_eq!(app.get(id, "business").await, (200, b"ok".to_vec()));
    }
}

/// 目录正文按字节读写，替换已有文件必须显式确认。
#[tokio::test]
async fn round_trips_bytes_and_requires_explicit_replace() {
    let app = Http::new();
    let id = app.create("材料").await;
    let path = "材料/#&!= x.bin";
    let first = [0xffu8, 0x00, 0x01, b'\n'];
    assert_eq!(app.mkdir(&id, "材料").await, 204);
    assert_eq!(app.put(&id, path, &first, false).await, 204);
    assert_eq!(app.get(&id, path).await, (200, first.to_vec()));
    assert_eq!(
        app.tree(&id).await,
        vec![
            json!({"path":"材料","kind":"dir"}),
            json!({"path":path,"kind":"file","size":4}),
        ]
    );
    let second = b"second";
    assert_eq!(app.put(&id, path, second, false).await, 409);
    assert_eq!(app.get(&id, path).await.1, first.to_vec());
    assert_eq!(app.put(&id, path, second, true).await, 204);
    assert_eq!(app.get(&id, path).await.1, second.to_vec());
    // 空文件也是合法内容。
    assert_eq!(app.put(&id, "empty", b"", false).await, 204);
    assert_eq!(app.get(&id, "empty").await, (200, Vec::new()));
    // 父目录不存在时不隐式创建，也不当目录写。
    assert_eq!(app.put(&id, "missing/a.txt", b"x", false).await, 404);
    assert_eq!(app.put(&id, "材料", b"x", true).await, 409);
    assert_eq!(app.get(&id, "材料").await.0, 404);
    assert_eq!(app.get(&id, "nope").await.0, 404);
}

/// 相对路径只接受名称段，任何一级符号链接都拒绝，包外文件不可达。
#[tokio::test]
async fn rejects_unsafe_paths_and_symlinks() {
    let app = Http::new();
    let id = app.create("安全").await;
    let outside = app.dir.path("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), b"private").unwrap();

    for bad in [
        "",
        "/etc/passwd",
        "../escape",
        "a/../../escape",
        "a//b",
        "a/./b",
        "a/",
    ] {
        assert_eq!(app.put(&id, bad, b"x", true).await, 400, "{bad}");
        assert_eq!(app.mkdir(&id, bad).await, 400, "{bad}");
        assert_eq!(app.remove(&id, bad).await, 400, "{bad}");
        assert_eq!(app.get(&id, bad).await.0, 400, "{bad}");
    }
    assert!(!app.dir.path("escape").exists());
    // 超过层级上限的路径同样拒绝。
    let deep = (0..40)
        .map(|i| format!("d{i}"))
        .collect::<Vec<_>>()
        .join("/");
    assert_eq!(app.put(&id, &deep, b"x", true).await, 400);

    let root = app.dir.package(&id);
    symlink(&outside, root.join("link")).unwrap();
    symlink(outside.join("secret"), root.join("alias")).unwrap();
    assert_eq!(app.paths(&id).await, Vec::<String>::new());
    assert_eq!(app.get(&id, "link/secret").await.0, 500);
    assert_eq!(app.put(&id, "link/planted", b"x", false).await, 500);
    assert!(!outside.join("planted").exists());
    assert_eq!(app.get(&id, "alias").await.0, 404);
    assert_eq!(app.put(&id, "alias", b"x", true).await, 500);
    assert_eq!(fs::read(outside.join("secret")).unwrap(), b"private");
    // 包根被换成符号链接时整个包不可用。
    let other = app.create("被替换").await;
    let other_root = app.dir.package(&other);
    fs::remove_dir_all(&other_root).unwrap();
    symlink(&outside, &other_root).unwrap();
    assert_eq!(
        app.call("GET", &format!("/v2/directories/{other}/tree"), Value::Null)
            .await
            .0,
        500
    );
}

/// 目录单建、移动不覆盖、可删非空目录。
#[tokio::test]
async fn creates_moves_and_removes_entries() {
    let app = Http::new();
    let id = app.create("整理").await;
    assert_eq!(app.mkdir(&id, "a").await, 204);
    assert_eq!(app.mkdir(&id, "a").await, 409);
    assert_eq!(app.mkdir(&id, "a/b").await, 204);
    assert_eq!(app.put(&id, "a/b/f.txt", b"body", false).await, 204);
    assert_eq!(app.relocate(&id, "a", "c").await, 204);
    assert_eq!(app.paths(&id).await, vec!["c", "c/b", "c/b/f.txt"]);
    assert_eq!(app.relocate(&id, "c", "c/b/inside").await, 400);
    assert_eq!(app.relocate(&id, "c", "d/e").await, 404);
    assert_eq!(app.relocate(&id, "missing", "x").await, 404);
    assert_eq!(app.mkdir(&id, "d").await, 204);
    assert_eq!(app.put(&id, "d/exists", b"x", false).await, 204);
    assert_eq!(app.relocate(&id, "c", "d/exists").await, 409);
    assert_eq!(app.relocate(&id, "c", "d/exists/deep").await, 404);
    // 非空目录可以删除，删掉的文件不再出现。
    assert_eq!(app.mkdir(&id, "c/b/extra").await, 204);
    assert_eq!(app.remove(&id, "c").await, 204);
    assert_eq!(app.paths(&id).await, vec!["d", "d/exists"]);
    assert_eq!(app.remove(&id, "c").await, 404);
    assert_eq!(app.remove(&id, "d/exists").await, 204);
    assert_eq!(app.paths(&id).await, vec!["d"]);
    // 跨包隔离：另一份包看不到这些文件。
    let other = app.create("另一份").await;
    assert_eq!(app.paths(&other).await, Vec::<String>::new());
}

/// 同时写入同一路径时串行执行，结果不会交错，也不留下临时文件。
#[tokio::test]
async fn serializes_concurrent_writes_to_one_path() {
    let app = Http::new();
    let id = app.create("并发").await;
    let (one, two) = tokio::join!(
        app.put(&id, ".gitignore", b"a", false),
        app.put(&id, ".gitignore", b"b", false)
    );
    assert!(matches!((one, two), (204, 409) | (409, 204)));
    assert_eq!(app.paths(&id).await, vec![".gitignore"]);
    assert_eq!(app.remove(&id, ".gitignore").await, 204);
    let left = vec![b'a'; 1024 * 1024];
    let right = vec![b'b'; 1024 * 1024];
    let (a, b) = tokio::join!(
        app.put(&id, "shared.bin", &left, true),
        app.put(&id, "shared.bin", &right, true)
    );
    assert_eq!((a, b), (204, 204));
    let body = app.get(&id, "shared.bin").await.1;
    assert!(body == left || body == right);
    let root = app.dir.package(&id);
    let leftovers: Vec<String> = fs::read_dir(&root)
        .unwrap()
        .map(|item| item.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.starts_with('.'))
        .collect();
    assert_eq!(leftovers, Vec::<String>::new());
    // 失败写入同样不留下临时文件。
    assert_eq!(app.put(&id, "shared.bin", b"x", false).await, 409);
    assert_eq!(app.paths(&id).await, vec!["shared.bin"]);
}

/// 大小上限在写入前判断，超限请求不会创建文件。
#[test]
fn enforces_limits_before_touching_disk() {
    let temp = Temp::new();
    let root = temp.path("pack");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();

    let big = vec![0u8; dir::FILE_LIMIT as usize + 1];
    assert!(matches!(
        dir::write(&root, &[("big".to_owned())], &big, false),
        Err(Fault::Invalid(_))
    ));
    assert!(!root.join("big").exists());
    assert!(dir::segments(&"a/".repeat(300), false).is_err());
    assert!(dir::segments(&"a".repeat(256), false).is_err());
    assert!(matches!(
        dir::segments("a\u{7}b", false),
        Err(Fault::Invalid(_))
    ));
    assert_eq!(dir::segments("", true).unwrap(), Vec::<String>::new());
}
