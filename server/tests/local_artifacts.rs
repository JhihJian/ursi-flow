//! 本地归档 API：真实生产装配、临时 SQLite 与内容目录，不连接 Gateway。
use flow_core::{
    artifacts::{ARTIFACT_MIGRATIONS, ArtifactRecord, ArtifactStore, PutArtifactRequest},
    domain::{ArtifactContract, Run, RunStatus, WorkflowDefinition},
    runs::{RunRepository, SqliteRunStore, SystemClock},
    storage::{ContentStore, Database},
};
use reqwest::StatusCode;
use serde_json::{Value, json};
use std::{fs, sync::Arc};
use ursi_server::app::{App, AppConfig, assemble};

fn store(cfg: &AppConfig) -> ArtifactStore {
    ArtifactStore::new(
        Database::open(cfg.data_dir.join("artifacts.db"), ARTIFACT_MIGRATIONS).unwrap(),
        ContentStore::open(cfg.data_dir.join("artifact-content")).unwrap(),
    )
}

fn put(store: &ArtifactStore, run: &str, attempt: u64, bytes: &[u8]) -> ArtifactRecord {
    store
        .put(PutArtifactRequest {
            run_id: run.into(),
            node_id: "n-1".into(),
            generation: 1,
            attempt,
            name: "report.md".into(),
            path: "out/report.md".into(),
            bytes: bytes.to_vec(),
            required: true,
            media_type: Some("text/markdown".into()),
            idempotency_key: format!("{run}:{attempt}"),
        })
        .unwrap()
}

async fn get(app: &App, suffix: &str, expected: StatusCode) -> Value {
    let url = format!("http://{}/api/v1/artifacts{suffix}", app.addr());
    let response = reqwest::get(url).await.unwrap();
    assert_eq!(response.status(), expected);
    response.json().await.unwrap()
}

#[tokio::test]
async fn declarations_without_an_archive_are_not_files() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = AppConfig::for_test(dir.path().to_owned());
    let app = assemble(cfg.clone()).await.unwrap();
    let runs = SqliteRunStore::open(cfg.runs_db_path(), Arc::new(SystemClock)).unwrap();
    let run = Run {
        id: "declared".into(),
        workflow: WorkflowDefinition {
            id: "wf".into(),
            name: "wf".into(),
            nodes: vec![],
            edges: vec![],
        },
        nodes: vec![],
        generation: 1,
        status: RunStatus::Queued,
    };
    runs.create_run(&run, &Default::default()).await.unwrap();
    let outside = dir.path().join("not-an-archive");
    fs::write(&outside, "not published").unwrap();
    runs.record_node_artifacts(
        &run.id,
        "n",
        1,
        1,
        &[ArtifactContract {
            name: "report".into(),
            path: outside.to_str().unwrap().into(),
            required: false,
            media_type: None,
        }],
    )
    .await
    .unwrap();
    assert_eq!(runs.list_node_artifacts(&run.id).await.unwrap().len(), 1);
    for suffix in ["", "?runId=declared", "?runId=other"] {
        assert_eq!(
            get(&app, suffix, StatusCode::OK).await,
            json!({"items": []})
        );
    }
    let unknown = get(&app, "/art-declared-n-1-report", StatusCode::NOT_FOUND).await;
    assert_eq!(unknown["error"]["code"], "not_found");
    app.shutdown().await;
}

#[tokio::test]
async fn list_and_read_stable_archives_across_attempts_runs_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = AppConfig::for_test(dir.path().to_owned());
    let app = assemble(cfg.clone()).await.unwrap();
    let archive = store(&cfg);
    let old = put(&archive, "r-a", 1, "第一轮\n".as_bytes());
    let new = put(&archive, "r-a", 2, b"");
    let other = put(&archive, "r-b", 1, &[0xff, 0x80]);
    drop(archive);

    let all = get(&app, "", StatusCode::OK).await;
    let items = all["items"].as_array().unwrap();
    let mut records = [&old, &new, &other];
    records.sort_by_key(|r| (&r.created_at, &r.artifact_id));
    assert_eq!(items.len(), records.len());
    for (item, r) in items.iter().zip(records) {
        assert_eq!(
            item,
            &json!({"id": r.artifact_id, "runId": r.run_id, "nodeId": "n-1",
            "attempt": r.attempt, "name": "report.md", "path": "out/report.md", "mediaType": "text/markdown"})
        );
    }
    for run in ["r-a", "r-b"] {
        let filtered: Vec<_> = items.iter().filter(|item| item["runId"] == run).collect();
        assert_eq!(
            get(&app, &format!("?runId={run}"), StatusCode::OK).await,
            json!({"items": filtered})
        );
    }
    app.shutdown().await;
    drop(app);

    let app = assemble(cfg).await.unwrap();
    for (record, text) in [(old, Some("第一轮\n")), (new, Some("")), (other, None)] {
        let item = get(&app, &format!("/{}", record.artifact_id), StatusCode::OK).await;
        assert_eq!(item["id"], record.artifact_id);
        assert_eq!(item["attempt"], record.attempt);
        assert_eq!(item.get("content"), text.map(Value::from).as_ref());
    }
    app.shutdown().await;
}

#[tokio::test]
async fn broken_objects_fail_without_fallback_or_disclosure() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = AppConfig::for_test(dir.path().to_owned());
    let app = assemble(cfg.clone()).await.unwrap();
    let record = put(&store(&cfg), "r", 1, b"original");
    let shard = dir
        .path()
        .join("artifact-content")
        .join(&record.content_id[..2]);
    let object = shard.join(&record.content_id);
    let suffix = format!("/{}", record.artifact_id);
    let expected = json!({"error": {"code": "internal_error", "message": "服务内部错误"}});
    fs::write(&object, b"tampered").unwrap(); // Same size, wrong hash.
    assert_eq!(
        get(&app, &suffix, StatusCode::INTERNAL_SERVER_ERROR).await,
        expected
    );
    fs::remove_file(&object).unwrap();
    assert_eq!(
        get(&app, &suffix, StatusCode::INTERNAL_SERVER_ERROR).await,
        expected
    );
    assert_eq!(
        get(&app, "", StatusCode::OK).await["items"][0]["id"],
        record.artifact_id
    );
    #[cfg(unix)]
    {
        // Same bytes: digest verification alone would accept either link.
        let outside = dir.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join(&record.content_id), b"original").unwrap();
        std::os::unix::fs::symlink(outside.join(&record.content_id), &object).unwrap();
        assert_eq!(
            get(&app, &suffix, StatusCode::INTERNAL_SERVER_ERROR).await,
            expected
        );
        fs::remove_file(&object).unwrap();
        fs::remove_dir(&shard).unwrap();
        std::os::unix::fs::symlink(outside, shard).unwrap();
        assert_eq!(
            get(&app, &suffix, StatusCode::INTERNAL_SERVER_ERROR).await,
            expected
        );
    }
    app.shutdown().await;
}
