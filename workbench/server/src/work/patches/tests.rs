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

const KINDS: [&str; 2] = ["work", "config"];

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
        let dir = Temp::new();
        let store = Store::open(dir.path("work")).unwrap();
        let app = directories::routes(store.clone())
            .unwrap()
            .merge(routes(store.clone()))
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

    async fn create(&self, kind: &str, name: &str) -> String {
        let patch = self
            .ok("POST", &format!("/v2/patches/{kind}"), json!({"name":name}))
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

/// 包列表只公布包标识和名称，两类包各自独立。
#[tokio::test]
async fn lists_packages_per_kind_and_rejects_bad_input() {
    let app = Http::new();
    for kind in KINDS {
        assert_eq!(
            app.ok("GET", &format!("/v2/patches/{kind}"), Value::Null)
                .await,
            json!([])
        );
    }
    let work = app.create("work", "  结算异常排查  ").await;
    let config = app.create("config", "审核助手").await;
    assert_ne!(work, config);
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
    let configs = app.ok("GET", "/v2/patches/config", Value::Null).await;
    assert_eq!(configs[0]["directoryId"], config);
    assert_eq!(configs[0]["name"], "审核助手");
    assert!(configs[0].get("executionStatus").is_none());
    // 另一类包的标识在交叉路径下不存在，磁盘也不共享。
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
async fn failed_conversion_never_claims_request_or_creates_a_directory() {
    let app = Http::new();
    let item = app
        .ok("POST", "/v2/work-items", json!({"title":"账单"}))
        .await;
    let path = format!("/v2/work-items/{}", item["id"].as_str().unwrap());
    let action = format!("{path}/generate");
    let request = json!({"requestId":"one-click"});
    assert_eq!(app.call("POST", &action, request.clone()).await.0, 400);
    let input = json!({"title":"账单", "revision":1,"recipe":{"resources":[{"alias":"bill","serverId":"missing","uri":"r://bill"}],"script":"example"}});
    app.ok("PUT", &path, input).await;
    assert_eq!(app.call("POST", &action, request).await.0, 404);
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
            "/v2/patches/config",
            json!({"name":"错类","workItemId":a["id"]})
        )
        .await
        .0,
        400
    );
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

/// 配置包创建即带三个锚点，锚点不能被移动或删除，mcp.json 只接受 JSON 对象。
#[tokio::test]
async fn seeds_config_anchors_and_guards_them() {
    let app = Http::new();
    let work = app.create("work", "空包").await;
    assert_eq!(app.paths(&work).await, Vec::<String>::new());

    let id = app.create("config", "配置包").await;
    assert_eq!(
        app.tree(&id).await,
        vec![
            json!({"path":"AGENTS.md","kind":"file","size":0}),
            json!({"path":"mcp.json","kind":"file","size":17}),
            json!({"path":"skills","kind":"dir"}),
        ]
    );
    assert_eq!(app.get(&id, "mcp.json").await.1, br#"{"mcpServers":{}}"#);
    assert_eq!(app.get(&id, "AGENTS.md").await.1, b"");
    // 系统提示词可写，覆盖需要显式确认。
    assert_eq!(app.put(&id, "AGENTS.md", b"# hola", false).await, 409);
    assert_eq!(app.put(&id, "AGENTS.md", b"# hola", true).await, 204);
    assert_eq!(app.get(&id, "AGENTS.md").await.1, b"# hola");

    // 坏 JSON 不覆盖已有文件，也不改变内容。
    assert_eq!(app.put(&id, "mcp.json", b"not json", true).await, 400);
    assert_eq!(app.put(&id, "mcp.json", b"[1]", true).await, 400);
    assert_eq!(app.get(&id, "mcp.json").await.1, br#"{"mcpServers":{}}"#);
    let body = br#"{"mcpServers":{"tools":{"command":"x"}}}"#;
    assert_eq!(app.put(&id, "mcp.json", body, true).await, 204);
    assert_eq!(app.get(&id, "mcp.json").await.1, body);
    // skills/ 下可以自由建文件。
    assert_eq!(app.mkdir(&id, "skills/review").await, 204);
    assert_eq!(
        app.put(&id, "skills/review/SKILL.md", b"# r", false).await,
        204
    );

    for anchor in ["AGENTS.md", "skills", "mcp.json"] {
        assert_eq!(app.relocate(&id, anchor, "moved").await, 409, "{anchor}");
        assert_eq!(app.remove(&id, anchor).await, 409, "{anchor}");
    }
    // 也不能把其他文件移动或改名成锚点。
    assert_eq!(
        app.relocate(&id, "AGENTS.md", "skills/AGENTS.md").await,
        409
    );
    assert_eq!(app.relocate(&id, "skills/review", "prompt").await, 204);
    assert_eq!(app.relocate(&id, "prompt/SKILL.md", "mcp.json").await, 409);
    // 工作包没有任何锚点限制。
    assert_eq!(app.put(&work, "AGENTS.md", b"x", false).await, 204);
    assert_eq!(app.mkdir(&work, "skills").await, 204);
    assert_eq!(app.relocate(&work, "AGENTS.md", "prompt.md").await, 204);
    assert_eq!(app.remove(&work, "skills").await, 204);
}

/// 工作包只能引用已存在的配置包，引用作为受限对象保存在工作包记录中。
#[tokio::test]
async fn work_package_accepts_only_config_package_reference() {
    let app = Http::new();
    let config_directory = app.create("config", "配置源").await;
    let config = app.ok("GET", "/v2/patches/config", Value::Null).await;
    let config_id = config[0]["id"].as_str().unwrap();
    let work = app
        .ok(
            "POST",
            "/v2/patches/work",
            json!({"name":"带配置","configPackage":{"id":config_id}}),
        )
        .await;
    assert_eq!(work["configPackage"], json!({"id":config_id}));
    assert_ne!(work["directoryId"], config_directory);
    assert_eq!(
        app.call(
            "POST",
            "/v2/patches/work",
            json!({"name":"不存在","configPackage":{"id":"missing"}}),
        )
        .await
        .0,
        404
    );
    assert_eq!(
        app.call(
            "POST",
            "/v2/patches/config",
            json!({"name":"嵌套","configPackage":{"id":config_id}}),
        )
        .await
        .0,
        400
    );
}

/// 配置包快照使用独立冻结目录，源目录与快照目录互不授予对方写权限。
#[tokio::test]
async fn round_trips_bytes_and_requires_explicit_replace() {
    let app = Http::new();
    let id = app.create("work", "材料").await;
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
    let id = app.create("work", "安全").await;
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
    let other = app.create("work", "被替换").await;
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
    let id = app.create("work", "整理").await;
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
    let other = app.create("work", "另一份").await;
    assert_eq!(app.paths(&other).await, Vec::<String>::new());
}

/// 同时写入同一路径时串行执行，结果不会交错，也不留下临时文件。
#[tokio::test]
async fn serializes_concurrent_writes_to_one_path() {
    let app = Http::new();
    let id = app.create("work", "并发").await;
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
    let config = app.create("config", "配置").await;
    assert_eq!(app.put(&config, "mcp.json", b"{", true).await, 400);
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
