use super::*;
use axum::{
    extract::Request,
    routing::{any, get},
};
use std::{
    fs,
    os::unix::fs::symlink,
    path::PathBuf,
    sync::{Arc, Mutex},
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> (Self, Store) {
        let path = env::temp_dir().join(Uuid::new_v4().to_string());
        let store = Store::open(path.clone()).unwrap();
        (Self(path), store)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn origin_and_bearer_are_configuration_only() {
    let (_t, s) = Temp::new();
    for url in [
        "file:///root",
        "https://user@example.org",
        "https://@example.org/",
        "https://example.org/?x",
        "http://example.org/path/..",
        "http://example.org\\a",
        "http://example.org/#x",
        "//example.org",
    ] {
        assert!(Platform::new(s.clone(), url, "valid").is_err(), "{url}");
    }
    for token in ["", " bad", "bad\r\nheader", "a b"] {
        assert!(Platform::new(s.clone(), "https://example.org/", token).is_err());
    }
}

async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = socket.local_addr().unwrap();
    (
        format!("http://{addr}"),
        tokio::spawn(async move {
            axum::serve(socket, app).await.unwrap();
        }),
    )
}

#[tokio::test]
async fn authenticated_proxy_freezes_patch_and_resolves_read_only_remote_handles() {
    let (_t, store) = Temp::new();
    let local = directories::allocate(
        &store,
        Default::default(),
        |root| {
            fs::create_dir(root.join("empty")).unwrap();
            fs::write(root.join("binary"), [255, 0]).unwrap();
            Ok(())
        },
        |db, dir| {
            db["workPatches"]["patch"] = json!({"id":"patch","directoryId":dir});
            Ok(dir.to_owned())
        },
    )
    .unwrap();
    let id = Uuid::new_v4().to_string();
    let remote = Uuid::new_v4().to_string();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mock = Router::new().fallback(any({
        let calls = calls.clone(); let id = id.clone(); let remote = remote.clone();
        move |req: Request| { let calls=calls.clone(); let id=id.clone(); let remote=remote.clone(); async move {
            assert_eq!(req.headers()[header::AUTHORIZATION],"Bearer upstream"); assert!(!req.headers().contains_key(header::COOKIE));
            let path = req.uri().to_string(); let method=req.method().clone();
            let bytes = axum::body::to_bytes(req.into_body(),1<<20).await.unwrap();
            calls.lock().unwrap().push((path.clone(),method.clone(),bytes));
            if path == format!("/api/v2/executor-attempts/{id}") {
                Json(json!({"attemptId":id,"status":"succeeded","artifactDirectoryRef":format!("artifacts:{id}"),"artifactDirectoryId":remote,"inputs":"private"})).into_response()
            } else if path == format!("/api/v2/directories/{remote}/file?path=binary") {
                ([(header::SET_COOKIE,"should-not-leave-upstream")],vec![255,0]).into_response()
            } else if path == "/api/v2/executors" { Json(json!([])).into_response() }
            else { panic!("unexpected upstream path {path}") }
        }}
    }));
    let (origin, backend) = serve(mock).await;
    let app = crate::work::business_routes(store.clone())
        .unwrap()
        .merge(router(
            Platform::new(store.clone(), &origin, "upstream").unwrap(),
        ));
    let (url, server) = serve(app).await;
    let client = Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        client
            .get(format!("{url}/v2/executors"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    for _ in 0..2 {
        let response = client.put(format!("{url}/v2/executor-attempts/{id}")).bearer_auth("browser").header(header::COOKIE,"client-only").json(&json!({"workPatchId":"patch","workInstruction":{"text":"read","encoding":"utf-8"},"executorRef":{"id":"reviewer","revision":1}})).send().await.unwrap();
        assert_eq!(response.status(), 200);
        let result = response.json::<Value>().await.unwrap();
        assert!(result.get("inputs").is_none());
        assert_eq!(
            result["artifactDirectoryId"],
            format!("platform-artifact-{id}")
        );
        fs::write(
            store.dir().join("directories").join(&local).join("binary"),
            b"changed",
        )
        .unwrap();
    }
    {
        let calls = calls.lock().unwrap();
        let request: Value = serde_json::from_slice(&calls[1].2).unwrap();
        assert!(request.get("workPatchId").is_none());
        assert_eq!(
            request["inputs"],
            json!([{"kind":"file","path":"binary","contentBase64":"/wA="},{"kind":"dir","path":"empty"}])
        );
        assert_eq!(calls[1], calls[2]);
    }
    let path = format!("{url}/v2/directories/platform-artifact-{id}/file?path=binary");
    let file = client.get(&path).send().await.unwrap();
    assert_eq!(file.status(), 200);
    assert!(file.headers().get(header::SET_COOKIE).is_none());
    assert_eq!(&file.bytes().await.unwrap()[..], &[255, 0]);
    let count = calls.lock().unwrap().len();
    assert_eq!(client.put(path).send().await.unwrap().status(), 405);
    assert_eq!(
        client
            .get(format!("{url}/v2/directories/{local}/file?path=binary"))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap(),
        "changed"
    );
    assert_eq!(
        client
            .get(format!("{url}/v2/executors/evil%2Fpath"))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        client
            .get(format!("{url}/v2/execution-attempts/{id}"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(calls.lock().unwrap().len(), count);
    server.abort();
    backend.abort();
}

#[tokio::test]
async fn does_not_follow_or_publish_upstream_redirects() {
    let (_t, s) = Temp::new();
    let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (target, trap) = serve(Router::new().fallback(any({
        let hits = hits.clone();
        move || {
            hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { StatusCode::OK }
        }
    })))
    .await;
    let (origin, b) = serve(Router::new().route(
        "/api/v2/executors",
        get(move || async move {
            (
                StatusCode::TEMPORARY_REDIRECT,
                [(header::LOCATION, target)],
                "secret",
            )
        }),
    ))
    .await;
    let (url, w) = serve(router(Platform::new(s, &origin, "token").unwrap())).await;
    let res = Client::new()
        .get(format!("{url}/v2/executors"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 503);
    assert!(res.headers().get(header::LOCATION).is_none());
    assert!(!res.text().await.unwrap().contains("secret"));
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);
    w.abort();
    b.abort();
    trap.abort();
}

#[tokio::test]
async fn work_patch_checks_only_the_remote_config_identity_before_allocating() {
    let (_tmp, store) = Temp::new();
    let existing = Uuid::new_v4().to_string();
    let missing = Uuid::new_v4().to_string();
    let unavailable = Uuid::new_v4().to_string();
    let mismatched = Uuid::new_v4().to_string();
    // A stale local row must not make an unknown platform reference valid.
    store
        .update(|db| {
            db["configPatches"][&missing] = json!({"id":missing,"directoryId":"local-only"});
            Ok(())
        })
        .unwrap();
    let mock = Router::new().route(
        "/api/v2/patches/config/{id}",
        get({
            let existing = existing.clone();
            let missing = missing.clone();
            let unavailable = unavailable.clone();
            move |Path(id): Path<String>, req: Request| async move {
                assert_eq!(req.headers()[header::AUTHORIZATION], "Bearer upstream");
                if id == existing {
                    Json(json!({"id":id})).into_response()
                } else if id == missing {
                    (StatusCode::NOT_FOUND, "private-error").into_response()
                } else if id == unavailable {
                    (StatusCode::FORBIDDEN, "private-error").into_response()
                } else {
                    Json(json!({"id":existing})).into_response()
                }
            }
        }),
    );
    let (origin, backend) = serve(mock).await;
    let platform = Platform::new(store.clone(), &origin, "upstream").unwrap();
    let (url, server) = serve(crate::work::patches::routes_with_platform(
        store.clone(),
        Some(platform),
    ))
    .await;
    let client = Client::new();
    let endpoint = format!("{url}/v2/patches/work");
    for (reference, status) in [
        (json!({"id":missing}), 404),
        (json!({"id":unavailable}), 503),
        (json!({"id":mismatched}), 503),
        (json!({"id":existing,"directoryId":"local-only"}), 422),
    ] {
        let res = client
            .post(&endpoint)
            .json(&json!({"name":"business", "configPackage":reference}))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), status);
        assert!(!res.text().await.unwrap().contains("private-error"));
    }
    store
        .read(|db| {
            assert!(db.get("workPatches").is_none());
            assert!(db.get("directories").is_none());
            Ok(())
        })
        .unwrap();
    let made: Value = client
        .post(&endpoint)
        .json(&json!({"name":"business","configPackage":{"id":existing}}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(made["configPackage"], json!({"id":existing}));
    let detail: Value = client
        .get(format!("{endpoint}/{}", made["id"].as_str().unwrap()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(made, detail);
    assert_eq!(
        store
            .read(|db| Ok(db["configPatches"].as_object().unwrap().len()))
            .unwrap(),
        1
    );
    server.abort();
    backend.abort();
}

#[test]
fn cached_snapshot_is_private_and_bound_to_attempt_origin_and_patch_across_restart() {
    use std::os::unix::fs::PermissionsExt;
    let (temp, store) = Temp::new();
    let local = directories::allocate(
        &store,
        Default::default(),
        |root| {
            fs::write(root.join("material"), b"first").unwrap();
            Ok(())
        },
        |db, id| {
            db["workPatches"]["p"] = json!({"id":"p","directoryId":id});
            Ok(id.to_owned())
        },
    )
    .unwrap();
    let first = inputs::snapshot(&store, "https://one/", "attempt", "p").unwrap();
    let cache = fs::read_dir(&temp.0)
        .unwrap()
        .filter_map(Result::ok)
        .find(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(".platform-inputs-")
        })
        .unwrap();
    assert_eq!(
        cache.metadata().unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::write(
        store.dir().join("directories").join(local).join("material"),
        b"edited",
    )
    .unwrap();
    drop(store);
    let store = Store::open(temp.0.clone()).unwrap();
    assert_eq!(
        inputs::snapshot(&store, "https://one/", "attempt", "p").unwrap(),
        first
    );
    assert!(matches!(
        inputs::snapshot(&store, "https://one/", "attempt", "other"),
        Err(Error::Conflict(_))
    ));
    assert_ne!(
        inputs::snapshot(&store, "https://two/", "attempt", "p").unwrap(),
        first
    );
    fs::write(cache.path(), b"not json").unwrap();
    assert!(inputs::snapshot(&store, "https://one/", "attempt", "p").is_err());
}

#[test]
fn links_are_not_input_materials() {
    let (_t, s) = Temp::new();
    directories::allocate(
        &s,
        Default::default(),
        |root| {
            symlink("/", root.join("escape")).unwrap();
            Ok(())
        },
        |db, dir| {
            db["workPatches"]["p"] = json!({"id":"p","directoryId":dir});
            Ok(())
        },
    )
    .unwrap();
    assert!(inputs::snapshot(&s, "https://example.org/", "attempt", "p").is_err());
}
