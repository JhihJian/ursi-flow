//! Gateway consumer contract, driven exclusively through production assembly.
#![cfg(feature = "sandbox-access")]

mod support;

use std::time::Duration;

use httptest::responders::{delay_and_then, status_code};
use reqwest::{Method, StatusCode};
use serde_json::json;
use tempfile::tempdir;

use support::fake_gateway::{
    ENDPOINT, FakeGateway, ID, accepted, error, example, reply, running, spec,
};
use support::{Api, expect};

const NORMAL: Duration = Duration::from_secs(3);

async fn prepare_pending(api: &Api, gateway: &mut FakeGateway, run: &str) {
    gateway.post(accepted());
    let pending = expect(api.prepare(run).await, StatusCode::ACCEPTED);
    assert_eq!(pending["runId"], run);
    assert_eq!(pending["id"], ID);
    assert_eq!(pending["status"], "PreparePending");
    gateway.verify();
    assert_eq!(api.local(run).await["status"], "PreparePending");
    gateway.verify(); // list is local; no GET expected.
}

async fn observe_ready(api: &Api, gateway: &mut FakeGateway, run: &str) {
    gateway.one("GET", running());
    let ready = expect(api.live(run).await, StatusCode::OK);
    assert_eq!(ready["status"], "Ready");
    assert_eq!(ready["endpoint"], ENDPOINT);
    gateway.verify();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_create_needs_live_observation_and_accepted_delete_needs_not_found() {
    let dir = tempdir().unwrap();
    let mut gateway = FakeGateway::new();
    let api = Api::start(dir.path(), &gateway, NORMAL).await;
    let run = "run-lifecycle";
    prepare_pending(&api, &mut gateway, run).await;

    let mut in_progress = example("running");
    in_progress["operation"] = json!({"kind":"start"});
    gateway.one("GET", reply(200, in_progress));
    let busy = expect(api.live(run).await, StatusCode::OK);
    assert_eq!(
        busy["status"], "PreparePending",
        "running with an operation is not ready"
    );
    gateway.verify();
    observe_ready(&api, &mut gateway, run).await;

    // Repeated prepare must observe the existing ID, not allocate another one.
    gateway.one("GET", running());
    assert_eq!(
        expect(api.prepare(run).await, StatusCode::CREATED)["status"],
        "Ready"
    );
    gateway.verify();

    gateway.one("DELETE", reply(202, example("deleting")));
    let deleting = expect(api.release(run).await, StatusCode::ACCEPTED);
    assert_eq!(deleting["status"], "ReleasePending");
    assert_eq!(api.local(run).await["status"], "ReleasePending");
    gateway.verify();

    gateway.one("GET", error(404, "not_found"));
    assert_eq!(
        expect(api.live(run).await, StatusCode::OK)["status"],
        "Released"
    );
    gateway.verify();
    assert_eq!(
        expect(api.release(run).await, StatusCode::OK)["status"],
        "Released"
    );
    gateway.verify();
    api.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn script_start_does_not_attempt_execution_on_an_accepted_resource() {
    let dir = tempdir().unwrap();
    let mut gateway = FakeGateway::new();
    let api = Api::start(dir.path(), &gateway, NORMAL).await;
    let run = api.script_run().await;
    prepare_pending(&api, &mut gateway, &run).await;
    gateway.expect_pending_recheck();
    expect(
        api.call(Method::POST, &format!("/runs/{run}/start"), None)
            .await,
        StatusCode::SERVICE_UNAVAILABLE,
    );
    gateway.verify();
    gateway.one("GET", running());
    let denied = expect(
        api.call(Method::POST, &format!("/runs/{run}/start"), None)
            .await,
        StatusCode::SERVICE_UNAVAILABLE,
    );
    assert_eq!(denied["error"]["code"], "sandbox_unavailable");
    let run = expect(
        api.call(Method::GET, &format!("/runs/{run}"), None).await,
        StatusCode::OK,
    );
    assert_eq!(run["nodes"][0]["status"], "pending");
    assert_eq!(run["nodes"][0]["attempt"], 0);
    gateway.verify();
    api.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn not_found_before_any_delete_is_not_a_release_confirmation() {
    let dir = tempdir().unwrap();
    let mut gateway = FakeGateway::new();
    let api = Api::start(dir.path(), &gateway, NORMAL).await;
    let run = "run-missing";
    prepare_pending(&api, &mut gateway, run).await;
    gateway.one("GET", error(404, "not_found"));
    expect(api.live(run).await, StatusCode::NOT_FOUND);
    gateway.verify();
    assert_ne!(api.local(run).await["status"], "Released");
    api.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auth_conflict_and_malformed_create_are_not_successful_prepares() {
    let dir = tempdir().unwrap();
    let mut gateway = FakeGateway::new();
    let api = Api::start(dir.path(), &gateway, NORMAL).await;
    let mut failures = Vec::new();
    for run in ["run-auth", "run-conflict", "run-malformed"] {
        match run {
            "run-auth" => gateway.post(reply(
                401,
                json!({"error":{"code":"unauthorized", "message":support::fake_gateway::KEY}}),
            )),
            "run-conflict" => gateway.post(error(409, "conflict")),
            _ => gateway.post(
                status_code(202)
                    .insert_header("content-type", "application/json")
                    .body("{\"id\":"),
            ),
        }
        let (status, body) = api.prepare(run).await;
        assert!(
            status.is_client_error() || status.is_server_error(),
            "{run}: {status}: {body}"
        );
        if run == "run-conflict" {
            assert_eq!(status, StatusCode::CONFLICT);
        }
        let code = body["error"]["code"].as_str().expect("classified error");
        failures.push((status, code.to_owned()));
        gateway.verify();
        let local = api.local(run).await;
        assert!(
            matches!(local["status"].as_str(), Some("Unknown" | "PreparePending")),
            "{local}"
        );
    }
    assert_eq!(
        failures[0],
        (StatusCode::BAD_GATEWAY, "gateway_unauthorized".into())
    );
    assert_eq!(
        failures[2],
        (StatusCode::BAD_GATEWAY, "gateway_protocol_error".into())
    );
    let store = ursi_server::sandboxes::SandboxStore::open(
        ursi_server::app::AppConfig::for_test(dir.path().to_owned()).sandboxes_db_path(),
    )
    .unwrap();
    let record = store.request_record("run-auth").unwrap().unwrap();
    assert!(
        !record
            .last_error
            .unwrap()
            .contains(support::fake_gateway::KEY)
    );
    api.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timeout_and_restart_replay_the_original_nonempty_key_and_frozen_spec() {
    let dir = tempdir().unwrap();
    let mut gateway = FakeGateway::new();
    let api = Api::start(dir.path(), &gateway, Duration::from_millis(250)).await;
    let run = "run-timeout";
    gateway.post(delay_and_then(Duration::from_secs(2), accepted()));
    let (status, body) = api.prepare(run).await;
    assert!(
        status.is_server_error() || (status == StatusCode::ACCEPTED && body["status"] == "Unknown"),
        "{status}: {body}"
    );
    gateway.verify();
    api.stop().await;

    let api = Api::start(dir.path(), &gateway, NORMAL).await;
    assert_eq!(api.local(run).await["status"], "Unknown");
    let mut changed = spec();
    changed["image"] = json!("cannot-replace-frozen-spec:latest");
    expect(
        api.call(
            Method::POST,
            "/sandboxes",
            Some(json!({"runId":run,"spec":changed})),
        )
        .await,
        StatusCode::CONFLICT,
    );
    gateway.verify(); // Reject drift locally: no allocation under a fresh key.
    prepare_pending(&api, &mut gateway, run).await;
    let keys = gateway.keys();
    assert_eq!(keys.len(), 2);
    assert_eq!(keys[0], keys[1], "retry allocated a new operation identity");
    observe_ready(&api, &mut gateway, run).await;
    api.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_and_mcp_release_denials_preserve_the_same_durable_association() {
    // Each release entry point starts from Ready; neither may report a prior
    // failed deletion as completion, even after the app reopens its database.
    for via_mcp in [false, true] {
        let dir = tempdir().unwrap();
        let mut gateway = FakeGateway::new();
        let api = Api::start(dir.path(), &gateway, NORMAL).await;
        let run = "run-release-denied";
        prepare_pending(&api, &mut gateway, run).await;
        observe_ready(&api, &mut gateway, run).await;
        gateway.one("DELETE", error(401, "unauthorized"));
        let (status, body) = if via_mcp {
            api.mcp("ops_stop_sandbox", json!({"sandbox_id":run})).await
        } else {
            api.release(run).await
        };
        assert!(
            status.is_client_error() || status.is_server_error(),
            "{status}: {body}"
        );
        gateway.verify();
        api.stop().await;

        let api = Api::start(dir.path(), &gateway, NORMAL).await;
        let local = api.local(run).await;
        assert_eq!(local["id"], ID);
        assert_eq!(local["status"], "ReleasePending");
        let listed = expect(
            api.mcp("ops_list_sandboxes", json!({"run_id":run})).await,
            StatusCode::OK,
        );
        let summary = &listed["result"][0];
        assert_eq!(summary["status"], "LastObserved(ReleasePending)");
        gateway.one("GET", running());
        let mcp = expect(
            api.mcp(
                "ops_get_sandbox",
                json!({"sandbox_id":summary["sandboxId"]}),
            )
            .await,
            StatusCode::OK,
        );
        assert_eq!(mcp["result"]["sandboxId"], run);
        assert_eq!(mcp["result"]["status"], "ReleasePending");
        gateway.verify();
        api.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_survives_failed_gateway_cleanup_without_recording_done() {
    let dir = tempdir().unwrap();
    let mut gateway = FakeGateway::new();
    let api = Api::start(dir.path(), &gateway, NORMAL).await;
    let run = api.script_run().await;
    prepare_pending(&api, &mut gateway, &run).await;
    observe_ready(&api, &mut gateway, &run).await;
    gateway.one("DELETE", error(409, "conflict"));
    let cancelled = expect(
        api.call(Method::POST, &format!("/runs/{run}/cancel"), None)
            .await,
        StatusCode::OK,
    );
    assert_eq!(cancelled["status"], "cancelled");
    gateway.verify();
    assert_eq!(api.local(&run).await["status"], "ReleasePending");
    api.stop().await;

    let path = ursi_server::app::AppConfig::for_test(dir.path().to_owned()).runs_db_path();
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let state: String = db
        .query_row(
            "SELECT state FROM cleanup_status WHERE run_id = ?1",
            [&run],
            |row| row.get(0),
        )
        .expect("durable cleanup outcome");
    assert!(
        matches!(state.as_str(), "pending" | "failed"),
        "cleanup outcome: {state}"
    );

    gateway.one("GET", error(404, "not_found"));
    let app =
        Api::with_cleanup_interval(dir.path(), &gateway, NORMAL, Duration::from_millis(40)).await;
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let cleanup: String = db
                .query_row(
                    "SELECT state FROM cleanup_status WHERE run_id = ?1",
                    [&run],
                    |r| r.get(0),
                )
                .unwrap();
            if cleanup == "done" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("cleanup confirmed after restart");
    assert_eq!(app.local(&run).await["status"], "Released");
    gateway.verify();
    app.stop().await;
}
