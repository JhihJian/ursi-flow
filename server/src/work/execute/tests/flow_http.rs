use super::*;

const ATTEMPTS: &str = "items/i/attempts";
const DETAIL: &str = "items/i/attempts/a";
const VERIFY: &str = "items/i/attempts/a/verify";

fn recovered() -> (Temp, Store, Api) {
    let temp = Temp::new();
    let store = Store::open(temp.0.join("db")).unwrap();
    store
        .update(|db| {
            let mut i = item();
            i["deliveries"] = json!([]);
            i["attempts"] = json!([{"id":"a", "backendRunId":"a", "status":"running",
            "executor":i["packageSnapshot"]["actions"]["verify"]["executor"]}]);
            db["items"]["i"] = i;
            Ok(())
        })
        .unwrap();
    let client = FlowClient::new(temp.0.join("daemon.sock"));
    let app = items::routes(store.clone()).merge(router(
        store.clone(),
        temp.0.clone(),
        Some(client),
        None,
        None,
    ));
    let api = Api::serve(&temp, app);
    (temp, store, api)
}
fn proof(status: &str) -> Value {
    json!({"status":status, "reason":"报告未生成", "evidence":"运维记录 #42 已核对进程与副作用"})
}
fn job(status: &str) -> Value {
    json!({"v":1,"data":{"id":"a","flow":"verification","revision":"f123","status":status}})
}
async fn get_request(listener: &UnixListener) -> UnixStream {
    let (mut socket, _) = tokio::time::timeout(READY_LIMIT, listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut buf = Vec::new();
    socket.read_to_end(&mut buf).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&buf).unwrap(),
        json!({"v":1,"op":"run.get","args":{"id":"a"}})
    );
    socket
}
fn daemon(temp: &Temp, replies: Vec<Value>) -> tokio::task::JoinHandle<()> {
    let listener = UnixListener::bind(temp.0.join("daemon.sock")).unwrap();
    tokio::spawn(async move {
        for reply in replies {
            get_request(&listener)
                .await
                .write_all(reply.to_string().as_bytes())
                .await
                .unwrap();
        }
    })
}

#[tokio::test]
async fn bound_unknown_and_confirmed_absence_allow_one_audited_resolution() {
    for (status, code, reply) in [
        ("failed", "unknown", job("unknown")),
        (
            "cancelled",
            "not_found",
            json!({"v":1,"error":"Run 不存在","code":"not_found"}),
        ),
    ] {
        let (temp, store, mut api) = recovered();
        let daemon = daemon(&temp, vec![reply.clone(), reply]);
        let delivery = json!({"files":{"report.txt":"经办人复核报告"},"attemptIds":["a"]});
        let before = api.request(DETAIL, None, 200).await;
        assert_eq!(before["status"], "unverified");
        api.request("items/i/deliveries", Some(delivery.clone()), 409)
            .await;
        let a = api.post(VERIFY, proof(status)).await;
        daemon.await.unwrap();
        assert_eq!(a["status"], status);
        assert_eq!(a["interruptedStatus"], "running");
        assert_eq!(a["output"], before["output"]);
        let v = &a["verification"];
        assert_eq!(v["previousStatus"], "unverified");
        for k in ["status", "reason", "evidence"] {
            assert_eq!(v[k], proof(status)[k]);
        }
        assert_eq!(
            v["daemonEvidence"],
            json!({"op":"run.get","runId":"a","flowId":"verification","flowRevision":"f123","result":code})
        );
        api.request(VERIFY, Some(proof("cancelled")), 409).await;
        assert_eq!(
            api.post("items/i/deliveries", delivery).await["status"],
            "review"
        );
        api.task.abort();
        assert!((&mut api.task).await.unwrap_err().is_cancelled());
        drop(api);
        drop(store);
        let reloaded = Store::open(temp.0.join("db")).unwrap();
        let api = Api::new(&temp, reloaded, temp.0.join("unused"));
        assert_eq!(api.request(ATTEMPTS, None, 200).await, json!([a]));
    }
}

#[tokio::test]
async fn fresh_lookup_wins_over_cached_unknown_and_manual_status() {
    for (reply, expected) in [
        (job("running"), "running"),
        (job("completed"), "succeeded"),
        (job("failed"), "failed"),
        (job("stopped"), "cancelled"),
        (job("future"), "unverified"),
        (json!({"v":1,"error":"404 Run 不存在"}), "unverified"),
        (
            json!({"v":2,"error":"Run 不存在","code":"not_found"}),
            "unverified",
        ),
        (
            json!({"v":1,"data":null,"error":"404","code":"not_found"}),
            "unverified",
        ),
    ]
    .into_iter()
    .chain(["id", "flow", "revision"].map(|field| {
        let mut reply = job("unknown");
        reply["data"][field] = "other".into();
        (reply, "unverified")
    })) {
        let (temp, _, api) = recovered();
        let daemon = daemon(&temp, vec![job("unknown"), reply]);
        assert_eq!(api.request(DETAIL, None, 200).await["status"], "unverified");
        api.request(VERIFY, Some(proof("failed")), 409).await;
        daemon.await.unwrap();
        let history = api.request(ATTEMPTS, None, 200).await;
        assert_eq!(history[0]["status"], expected);
        assert!(history[0].get("verification").is_none());
    }
}

#[tokio::test]
async fn missing_socket_and_inconsistent_local_binding_are_not_run_absence() {
    let (temp, store, api) = recovered();
    api.request(VERIFY, Some(proof("failed")), 409).await;
    store
        .update(|db| {
            attempt_mut(db, "i", "a")?["backendRunId"] = "other".into();
            Ok(())
        })
        .unwrap();
    let daemon = daemon(
        &temp,
        vec![json!({"v":1,"code":"not_found","error":"Run 不存在"})],
    );
    api.request(VERIFY, Some(proof("failed")), 409).await;
    assert_eq!(
        api.request(ATTEMPTS, None, 200).await[0]["status"],
        "unverified"
    );
    assert!(!daemon.is_finished());
    daemon.abort();
}

#[tokio::test]
async fn late_verification_cannot_overwrite_a_confirmed_terminal() {
    let (temp, _, api) = recovered();
    let listener = UnixListener::bind(temp.0.join("daemon.sock")).unwrap();
    let verify = api.request(VERIFY, Some(proof("failed")), 409);
    let interleave = async {
        let mut delayed = get_request(&listener).await;
        let get = api.request(DETAIL, None, 200);
        let complete = async {
            get_request(&listener)
                .await
                .write_all(job("completed").to_string().as_bytes())
                .await
                .unwrap();
        };
        let (finished, ()) = tokio::join!(get, complete);
        assert_eq!(finished["status"], "succeeded");
        delayed
            .write_all(job("unknown").to_string().as_bytes())
            .await
            .unwrap();
        finished
    };
    let (_, finished) = tokio::join!(verify, interleave);
    assert_eq!(api.request(ATTEMPTS, None, 200).await, json!([finished]));
}

#[test]
fn transport_errors_never_authorize_a_manual_outcome() {
    use std::io::{Error as IoError, ErrorKind};
    for err in [
        IoError::from(ErrorKind::TimedOut),
        IoError::from(ErrorKind::ConnectionRefused),
        IoError::from_raw_os_error(libc::ENOENT),
    ] {
        assert!(matches!(
            flow::lookup(&Value::Null, Err(err)),
            flow::Observation::Inconclusive(_)
        ));
    }
}
