#[path = "flow_http.rs"]
mod flow_http;
#[path = "sandbox_http.rs"]
mod sandbox_http;

use super::*;
use crate::work::{catalog, items};
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
            "{path}: {body}"
        );
        if expected == 200 {
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
        json!({"id":"pi","kind":"agent","inputs":ports,"outputs":outputs,"resources":[refs[2]]}),
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
    assert_eq!(a["workspace"], "default");
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
    assert!(
        !api.request(&path, None, 200)
            .await
            .to_string()
            .contains(temp.0.to_str().unwrap())
    );

    api.post("executors", json!({"id":"checker","kind":"flow","flowId":"check","flowRevision":"revA","inputs":ports,"outputs":outputs,"resources":[]})).await;
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
