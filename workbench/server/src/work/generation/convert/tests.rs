use super::*;
use crate::work::generation::{Recipe, Resource};
use crate::work::{Store, mcp};
use axum::{
    Json, Router,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use std::{fs, path::PathBuf};
use tokio::{net::TcpListener, task::JoinHandle};
use uuid::Uuid;

struct Fixture {
    dir: PathBuf,
    platform: McpPlatform,
    server: JoinHandle<()>,
    id: String,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        let _ = fs::remove_dir_all(&self.dir);
    }
}
impl Fixture {
    async fn new() -> Self {
        let dir = std::env::temp_dir().join(Uuid::new_v4().to_string());
        let platform = mcp::platform(&Store::open(dir.clone()).unwrap());
        let sock = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", sock.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(sock, Router::new().route("/mcp", post(peer)))
                .await
                .unwrap()
        });
        let id = platform
            .register(
                serde_json::from_value(json!({"name":"反馈","url":url,"binding":"platform"}))
                    .unwrap(),
            )
            .unwrap()
            .id;
        Self {
            dir,
            platform,
            server,
            id,
        }
    }
}
async fn peer(Json(q): Json<Value>) -> Response {
    let result = match q["method"].as_str() {
        Some("server/discover") => return StatusCode::BAD_REQUEST.into_response(),
        Some("initialize") => {
            json!({"protocolVersion":"2025-06-18","capabilities":{"resources":{}},"serverInfo":{"name":"fixture","version":"1"}})
        }
        Some("notifications/initialized") => return StatusCode::ACCEPTED.into_response(),
        Some("resources/read") if q["params"]["uri"] == "memo:a" => {
            json!({"contents":[{"uri":"memo:a","text":"来自服务"},{"uri":"memo:a","blob":"AP8="}]})
        }
        _ => {
            return Json(
                json!({"jsonrpc":"2.0","id":q["id"],"error":{"code":-32002,"message":"not found"}}),
            )
            .into_response();
        }
    };
    Json(json!({"jsonrpc":"2.0","id":q["id"],"result":result})).into_response()
}
fn item(id: &str, uri: &str, script: &str) -> (Value, Recipe) {
    (
        json!({"id":"i","title":"本周","description":"","category":"continuous","status":"active","revision":3}),
        Recipe {
            resources: vec![Resource {
                alias: "note".into(),
                server_id: id.to_owned(),
                uri: uri.to_owned(),
            }],
            script: script.into(),
        },
    )
}

#[test]
fn python_item_snapshot_contains_category_and_status() {
    let (item, _) = item("s", "memo:a", "example");
    let context = WorkContext {
        id: item["id"].as_str().unwrap().into(),
        title: item["title"].as_str().unwrap().into(),
        description: item["description"].as_str().unwrap().into(),
        category: item["category"].clone(),
        status: item["status"].clone(),
        revision: item["revision"].clone(),
    };
    assert_eq!(
        item_snapshot(&context),
        json!({"id":"i","title":"本周","description":"","category":"continuous","status":"active"})
    );
}

#[tokio::test]
async fn read_error_and_missing_sandbox_are_terminal() {
    let f = Fixture::new().await;
    let (item, recipe) = item(&f.id, "memo:missing", "raise Exception()");
    let result = execute(&f.platform, Some(&context(&item)), &recipe, &mut Progress::default())
        .await;
    assert!(matches!(result,Err(Error::Unavailable(s)) if s.contains("memo:missing")));
    assert!(matches!(
        sandbox::execute("/nonexistent/bwrap", &json!({})).await,
        Err(Error::Unavailable(_))
    ));
}

#[test]
fn rejects_invalid_package_wholesale() {
    let ok = json!({"path":"有效/a","text":"hi"});
    for bad in [
        ok.clone(),
        json!({"path":"有效","text":""}),
        json!({"path":"有效/a/b","text":""}),
        json!({"path":"../a","text":""}),
        json!({"path":"a","blob":"!"}),
        json!({"path":"a","text":"","blob":null}),
    ] {
        assert!(package(json!({"name":"结果","files":[ok,bad]}), Value::Null).is_err());
    }
    assert!(package(json!({"name":"结果","files":vec![ok;129]}), Value::Null).is_err());
}
#[tokio::test]
#[ignore = "需要可用的 Linux bwrap 用户命名空间与 libseccomp"]
async fn isolated_live_read_to_files() {
    let f = Fixture::new().await;
    let script = "def transform(item, resources):\n assert (item['category'], item['status']) == ('continuous', 'active')\n p=resources['note']['contents']\n return {'name':item['title'],'files':[{'path':'材料/a','text':p[0]['text']},{'path':'b','blob':p[1]['blob']}]}";
    let (item, recipe) = item(&f.id, "memo:a", script);
    let mut progress = Progress::default();
    let g = execute(&f.platform, Some(&context(&item)), &recipe, &mut progress)
        .await
        .unwrap();
    assert_eq!(g.name, "本周");
    assert_eq!(
        g.files,
        vec![
            ("材料/a".into(), "来自服务".as_bytes().to_vec()),
            ("b".into(), vec![0, 255])
        ]
    );
    assert_eq!(g.provenance["revision"], 3);
    assert_eq!(g.provenance["resources"][0]["serverId"], f.id);
    assert!(g.provenance["resources"][0]["readAt"].as_u64().is_some());
    assert_eq!(
        g.provenance["scriptSha256"],
        format!("{:x}", Sha256::digest(script))
    );
}
#[tokio::test]
#[ignore = "需要可用的 Linux bwrap 用户命名空间与 libseccomp"]
async fn isolated_script_has_no_host_files_processes_or_unbounded_output() {
    let probe = "def transform(i,r):\n import ctypes, errno\n libc=ctypes.CDLL(None,use_errno=True)\n return libc.socket(2,1,0) == -1 and ctypes.get_errno() == errno.EPERM";
    let input = json!({"item":{}, "resources":{}, "script":probe});
    assert_eq!(sandbox::run(&input).await.unwrap(), json!(true));
    for command in [
        "open('/usr/bin/python3', 'rb')",
        "import os; os.fork()",
        "import os; assert 'HOME' in os.environ",
        "raise RuntimeError('private')",
        "while True: pass",
        "return 'x' * (7 << 20)",
    ] {
        let v =
            json!({"item":{},"resources":{},"script":format!("def transform(i,r):\n {command}")});
        assert!(
            matches!(sandbox::run(&v).await, Err(Error::Invalid(_))),
            "{command}"
        );
    }
}

fn context(item: &Value) -> WorkContext {
    WorkContext {
        id: item["id"].as_str().unwrap().into(),
        title: item["title"].as_str().unwrap().into(),
        description: item["description"].as_str().unwrap().into(),
        category: item["category"].clone(),
        status: item["status"].clone(),
        revision: item["revision"].clone(),
    }
}
