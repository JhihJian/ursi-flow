#[path = "flow_http.rs"]
mod flow_http;
#[path = "sandbox_http.rs"]
mod sandbox_http;

use super::*;
use crate::work::{catalog, directories, items};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
};

// Exercise the real catalog, item and attempt routes against a single private store.
struct Api {
    socket: PathBuf,
    task: tokio::task::JoinHandle<()>,
}
impl Api {
    fn new(temp: &Temp, store: Store, bin: PathBuf) -> Self {
        Self::configured(temp, store, bin, None)
    }
    fn configured(temp: &Temp, store: Store, bin: PathBuf, cfg: Option<sandbox::Config>) -> Self {
        let app = catalog::routes(store.clone())
            .merge(items::routes(store.clone()))
            .merge(directories::routes(store.clone()).unwrap())
            .merge(router(store, temp.0.clone(), None, Some(bin), cfg));
        Self::serve(temp, app)
    }
    fn serve(temp: &Temp, app: Router) -> Self {
        let socket = temp.0.join(Uuid::new_v4().to_string());
        let listener = UnixListener::bind(&socket).unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { socket, task }
    }
    async fn request(&self, path: &str, body: Option<Value>, expected: u16) -> Value {
        let method = if body.is_some() { "POST" } else { "GET" };
        self.send(method, path, body, expected).await
    }
    async fn send(&self, method: &str, path: &str, body: Option<Value>, expected: u16) -> Value {
        let data = body.map(|v| v.to_string()).unwrap_or_default();
        let mut conn = UnixStream::connect(&self.socket).await.unwrap();
        let request = format!(
            "{method} /v2/{path} HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{data}",
            data.len()
        );
        conn.write_all(request.as_bytes()).await.unwrap();
        let mut reply = String::new();
        conn.read_to_string(&mut reply).await.unwrap();
        let (head, body) = reply.split_once("\r\n\r\n").unwrap();
        assert_eq!(
            head.split_whitespace().nth(1).unwrap(),
            expected.to_string(),
            "{method} {path}: {body}"
        );
        if expected == 200 && !body.is_empty() {
            serde_json::from_str(body).unwrap()
        } else {
            Value::Null
        }
    }
    async fn post(&self, path: &str, data: Value) -> Value {
        self.request(path, Some(data), 200).await
    }
}
impl Drop for Api {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn catalog_publication_to_plan_and_agent_uses_frozen_resources_and_ports() {
    let temp = Temp::new();
    let store = Store::open(temp.0.join("db")).unwrap();
    let api = Api::new(&temp, store, temp.script("pwd\ncat"));
    let ports = json!({"ticket":"string"});
    let outputs = json!({"report":"string"});
    let mut refs = Vec::new();
    for (id, kind) in [
        ("shared", "prompt"),
        ("action", "skill"),
        ("executor", "prompt"),
    ] {
        let r = api
            .post(
                "resources",
                json!({"id":id,"kind":kind,"content":format!("body:{id}")}),
            )
            .await;
        refs.push(json!({"id":id,"revision":r["revision"]}));
    }
    api.post(
        "executors",
        json!({"id":"pi","kind":"agent","resources":[refs[2]]}),
    )
    .await;
    api.post(
        "packages",
        json!({"id":"case","sop":"核查","acceptance":"有报告","resources":[refs[0]],
        "inputs":ports,"outputs":outputs,"actions":{"work":{"executor":{"id":"pi","revision":1},
        "inputs":ports,"outputs":outputs,"resources":[refs[1], refs[0]]}}}),
    )
    .await;
    api.post(
        "resources",
        json!({"id":"executor","kind":"prompt","content":"new body"}),
    )
    .await;
    let input = json!({"ticket":"A-17"});
    let i = api
        .post(
            "items",
            json!({"package":"case","revision":1,"requestId":"case1","input":input}),
        )
        .await;
    let path = format!("items/{}", i["id"].as_str().unwrap());
    api.post(&format!("{path}/start"), json!({"assignee":"经办人"}))
        .await;
    let attempts = format!("{path}/attempts");
    let a = api.post(&attempts, json!({"action":"work"})).await;
    assert_eq!(
        a["workspace"],
        json!({"id":"default","access":"read-write","purpose":"work-input"})
    );
    assert_eq!(a["artifactDirectory"]["state"], "writable");
    assert!(a["artifactDirectory"]["id"].is_string());
    assert_eq!(a["workInstruction"]["encoding"], "utf-8");
    assert!(
        a["workInstruction"]["text"]
            .as_str()
            .unwrap()
            .contains("A-17")
    );
    assert_eq!(a["platformLog"][0]["event"], "attempt_created");
    assert_eq!(a["executorLog"], Value::Null);
    assert_eq!(a["executorLogPage"], Value::Null);
    assert_eq!(a["resources"].as_array().unwrap().len(), 3);
    let detail = format!("{attempts}/{}", a["id"].as_str().unwrap());
    let a = tokio::time::timeout(READY_LIMIT, async {
        loop {
            let a = api.request(&detail, None, 200).await;
            if a["status"] != "running" {
                break a;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(a["status"], "succeeded");
    let output = a["output"].as_str().unwrap();
    for part in [
        "[workspace]",
        "body:shared",
        "body:action",
        "body:executor",
        "A-17",
    ] {
        assert_eq!(output.matches(part).count(), 1, "{output}");
    }
    assert!(!output.contains("new body"));
    assert_eq!(a["artifactDirectory"]["state"], "frozen");
    assert_eq!(
        a["platformLog"].as_array().unwrap().last().unwrap()["event"],
        "artifact_directory_frozen"
    );
    assert_eq!(a["executorLog"]["source"], "agent");
    assert_eq!(a["executorLog"]["entries"][0]["text"], output);
    assert!(
        !api.request(&path, None, 200)
            .await
            .to_string()
            .contains(temp.0.to_str().unwrap())
    );

    api.post(
        "executors",
        json!({"id":"checker","kind":"flow","flowId":"check","flowRevision":"revA"}),
    )
    .await;
    api.post(
        "packages",
        json!({"id":"flowcase","sop":"核查","acceptance":"有报告","inputs":ports,"outputs":outputs,
        "actions":{"check":{"executor":{"id":"checker","revision":1}}}}),
    )
    .await;
    let i = api
        .post(
            "items",
            json!({"package":"flowcase","revision":1,"requestId":"case2","input":input}),
        )
        .await;
    let i = api
        .post(
            &format!("items/{}/start", i["id"].as_str().unwrap()),
            json!({"assignee":"经办人"}),
        )
        .await;
    let (
        plan::Plan::Flow {
            id,
            revision,
            variables,
        },
        _,
    ) = plan::resolve(&i, "check").unwrap()
    else {
        panic!()
    };
    assert_eq!(
        (id.as_str(), revision.as_str(), variables),
        ("check", "revA", input)
    );
}

#[tokio::test]
async fn recovered_local_attempt_needs_one_evidenced_decision_before_delivery() {
    let temp = Temp::new();
    let store = Store::open(temp.0.join("db")).unwrap();
    store.update(|db| {
        db["items"]["i"] = item();
        db["items"]["i"]["deliveries"] = json!([]);
        db["items"]["i"]["attempts"] = json!([{"id":"a","executor":{"kind":"agent"},"status":"running","workspace":temp.0}]);
        db["items"]["other"] = json!({"attempts":[{"id":"a","executor":{"kind":"flow"},"status":"unverified"}]});
        Ok(())
    }).unwrap();
    let bin = temp.script("touch replay");
    let api = Api::new(&temp, store.clone(), bin.clone());
    let verify = "items/i/attempts/a/verify";
    let proof =
        json!({"status":"failed","reason":"未生成报告","evidence":"执行日志 #42 记录异常退出"});
    let files = json!({"files":{"report.txt":"经办人核查报告"},"attemptIds":["a"]});
    api.request("items/i/deliveries", Some(files.clone()), 409)
        .await;
    for (field, value, status) in [
        ("status", "succeeded", 422),
        ("reason", "  ", 400),
        ("evidence", "", 400),
    ] {
        let mut invalid = proof.clone();
        invalid[field] = value.into();
        api.request(verify, Some(invalid), status).await;
    }
    api.request("items/other/attempts/a/verify", Some(proof.clone()), 409)
        .await;
    api.request("items/i/attempts/other/verify", Some(proof.clone()), 404)
        .await;
    let before = api.request("items/i/attempts/a", None, 200).await;
    assert_eq!(before["status"], "unverified");
    assert_eq!(before["interruptedStatus"], "running");
    let a = api.post(verify, proof.clone()).await;
    assert_eq!(a["status"], "failed");
    assert_eq!(a["output"], before["output"]);
    assert_eq!(a["verification"]["previousStatus"], "unverified");
    for field in ["status", "evidence", "reason"] {
        assert_eq!(a["verification"][field], proof[field]);
    }
    api.request(
        verify,
        Some(json!({"status":"cancelled","reason":"新原因","evidence":"新依据"})),
        409,
    )
    .await;
    assert_eq!(
        api.post("items/i/deliveries", files).await["status"],
        "review"
    );
    drop(api);
    let api = Api::new(&temp, store, bin);
    assert_eq!(api.request("items/i/attempts", None, 200).await, json!([a]));
    assert!(!temp.0.join("replay").exists());
}

/// 等到尝试离开 `running`。本地 Agent 任务与 HTTP 响应并行，测试只观察持久化结果。
async fn settle(api: &Api, path: &str, created: &Value) -> Value {
    let detail = format!("{path}/{}", created["id"].as_str().unwrap());
    tokio::time::timeout(READY_LIMIT, async {
        loop {
            let a = api.request(&detail, None, 200).await;
            if a["status"] != "running" {
                break a;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn agent_artifacts_are_registered_frozen_and_never_expose_host_paths() {
    let temp = Temp::new();
    let store = Store::open(temp.0.join("db")).unwrap();
    // 执行器把结果写入平台分配的制品目录；失败时也保留已写文件。
    let bin = temp.script(
        "cat >/dev/null\nprintf '报告正文' > \"$URSI_ARTIFACT_DIR/report.md\"\ntest ! -e fail || exit 3\npwd",
    );
    let api = Api::new(&temp, store.clone(), bin);
    let ports = json!({"ticket":"string"});
    api.post(
        "executors",
        json!({"id":"pi","kind":"agent","resources":[]}),
    )
    .await;
    api.post(
        "packages",
        json!({"id":"case","sop":"核查","acceptance":"有报告","inputs":ports,
        "outputs":{"report":"string"},"actions":{"work":{"executor":{"id":"pi","revision":1}}}}),
    )
    .await;
    let i = api
        .post(
            "items",
            json!({"package":"case","revision":1,"requestId":"art-1","input":{"ticket":"A-17"}}),
        )
        .await;
    let path = format!("items/{}/start", i["id"].as_str().unwrap());
    api.post(&path, json!({"assignee":"经办人"})).await;
    let attempts = format!("items/{}/attempts", i["id"].as_str().unwrap());

    let first = api.post(&attempts, json!({"action":"work"})).await;
    let first = settle(&api, &attempts, &first).await;
    assert_eq!(first["status"], "succeeded", "{first}");
    assert_eq!(first["artifactDirectory"]["state"], "frozen");
    let directory = first["artifactDirectory"]["id"].as_str().unwrap();
    let tree = json!([{"path":"report.md","kind":"file","size":12}]);
    assert_eq!(
        api.request(&format!("directories/{directory}/tree"), None, 200)
            .await,
        tree
    );
    // 冻结后目录只读，文件和清单都保持原样。
    api.send(
        "PUT",
        &format!("directories/{directory}/file?path=late.md"),
        Some(json!("迟到")),
        409,
    )
    .await;
    api.send(
        "DELETE",
        &format!("directories/{directory}/entry?path=report.md"),
        None,
        409,
    )
    .await;
    assert_eq!(
        api.request(&format!("directories/{directory}/tree"), None, 200)
            .await,
        tree
    );
    // 执行器只看到平台分配的 workspace 与制品目录；宿主路径不随尝试返回。
    let text = first.to_string();
    assert!(!text.contains(temp.0.to_str().unwrap()), "{text}");
    assert!(text.contains(directory));
    assert_eq!(first["workInstruction"]["encoding"], "utf-8");

    // 重试分配新的制品目录，旧目录继续可读。
    fs::write(temp.0.join("fail"), "").unwrap();
    let second = api.post(&attempts, json!({"action":"work"})).await;
    let second = settle(&api, &attempts, &second).await;
    assert_eq!(second["status"], "failed", "{second}");
    assert_eq!(second["artifactDirectory"]["state"], "frozen");
    let retry = second["artifactDirectory"]["id"].as_str().unwrap();
    assert_ne!(retry, directory);
    assert_eq!(
        api.request(&format!("directories/{retry}/tree"), None, 200)
            .await,
        tree
    );
    assert_eq!(
        api.request(&format!("directories/{directory}/tree"), None, 200)
            .await,
        tree
    );
}
