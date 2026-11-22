use super::*;
use crate::work::{agent_backends::Registry, directories, patches};
use axum::{
    extract::Path,
    routing::{get, post},
};
use reqwest::{Client, RequestBuilder};
use std::path::PathBuf;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

const A: &str = "platform-key";
const W: &str = "workbench-key";
const R: &str = "runtime-key";
const ID: &str = "aaaaaaaa-bbbb-cccc-dddd-000000000001";

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("access-test-{}", Uuid::new_v4())))
    }
    fn open(&self) -> Store {
        Store::open_platform(self.0.clone()).unwrap()
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Server {
    url: String,
    client: Client,
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}
impl Server {
    async fn new(store: Store) -> Self {
        // Replace only the subprocess boundary. Real catalog, patch and directory
        // handlers (and their nested path templates) are mounted as in production.
        async fn record(
            State(s): State<Store>,
            Path(id): Path<String>,
            Json(v): Json<Value>,
        ) -> Json<Value> {
            s.update(|db| {
                db[ATTEMPTS][&id] =
                    json!({"request":v,"result":{"attemptId":id,"status":"running"}});
                Ok(Json(db[ATTEMPTS][&id]["result"].clone()))
            })
            .unwrap()
        }
        let registry = Registry::for_test(vec![]);
        let api = catalog::routes(store.clone(), registry.clone())
            .merge(registry.routes(store.clone()))
            .merge(patches::routes(store.clone()))
            .merge(directories::routes(store.clone()).unwrap())
            .merge(
                Router::new()
                    .route(
                        "/v2/executor-attempts/{id}",
                        get(|| async { "inspect" }).put(record),
                    )
                    .route(
                        "/v2/executor-attempts/{id}/cancel",
                        post(|| async { "cancel" }),
                    )
                    .with_state(store.clone()),
            );
        let app = secured(
            api,
            store,
            Tokens::new(A.into(), W.into(), R.into()).unwrap(),
        );
        Self::serve(app).await
    }
    async fn serve(app: Router) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/api/v2", listener.local_addr().unwrap());
        let (stop, rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await
                .unwrap();
        });
        Self {
            url,
            client: Client::builder().no_proxy().build().unwrap(),
            stop,
            task,
        }
    }
    fn req(&self, method: Method, path: &str, key: &str) -> RequestBuilder {
        self.client
            .request(method, format!("{}{path}", self.url))
            .bearer_auth(key)
    }
    async fn close(self) {
        drop(self.client);
        self.stop.send(()).unwrap();
        self.task.await.unwrap();
    }
}
fn seed(store: &Store) {
    store.update(|db| {
        db["catalog"]["executors"]["审阅"] = json!({"active":true,"revisions":[{"id":"审阅","revision":1,"agent":{"backendId":"private"},"credentials":"private"}]});
        Ok(())
    }).unwrap();
}
fn start_body() -> Value {
    json!({"executorRef":{"id":"审阅","revision":1},"workInstruction":{"text":"review","encoding":"utf-8"}})
}
async fn status(req: RequestBuilder) -> StatusCode {
    req.send().await.unwrap().status()
}
async fn value(req: RequestBuilder) -> Value {
    req.send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[test]
fn token_configuration() {
    for bad in ["", "with space", "\t", "\u{7f}", "密钥", W, R] {
        assert!(Tokens::new(bad.into(), W.into(), R.into()).is_err());
    }
    assert!(Tokens::new(A.into(), W.into(), W.into()).is_err());
    assert!(Tokens::new("!~".into(), W.into(), R.into()).is_ok());
}

#[tokio::test]
async fn auth_projection_and_management_routes() {
    let home = Home::new();
    let store = home.open();
    seed(&store);
    let api = Server::new(store).await;
    let list = format!("{}/executors", api.url);
    for bad in [
        "",
        "Basic platform-key",
        "bearer platform-key",
        "Bearer  platform-key",
        "Bearer wrong",
    ] {
        assert_eq!(
            status(api.client.get(&list).header(header::AUTHORIZATION, bad)).await,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        status(api.client.get(format!("{list}?token={A}"))).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        status(api.client.get(&list).bearer_auth(A).bearer_auth(W)).await,
        StatusCode::UNAUTHORIZED
    );
    for owner in [W, R] {
        let public = json!({"id":"审阅","revision":1,"agent":{}});
        let latest = json!({"id":"审阅","revision":1,"active":true,"agent":{}});
        for (path, expected) in [
            ("/executors", json!([latest])),
            ("/executors/审阅", latest),
            ("/executors/审阅/revisions", json!([public])),
            ("/executors/审阅/revisions/1", public),
        ] {
            assert_eq!(value(api.req(Method::GET, path, owner)).await, expected);
        }
        for (method, path) in [
            (Method::POST, "/executors"),
            (Method::POST, "/executors/审阅/deactivate"),
            (Method::HEAD, "/executors"),
            (Method::GET, "/resources"),
            (Method::POST, "/resources"),
            (Method::GET, "/agent-options"),
            (Method::GET, "/agent-backends"),
            (Method::POST, "/agent-backends/pi/check"),
            (Method::GET, "/patches/config"),
            (Method::POST, "/patches/config"),
            (Method::GET, "/directories"),
            (Method::POST, "/directories"),
        ] {
            assert_eq!(
                status(api.req(method, path, owner).json(&json!({}))).await,
                StatusCode::FORBIDDEN,
                "{path}"
            );
        }
    }
    assert_eq!(
        value(api.req(Method::GET, "/executors/审阅", A)).await["credentials"],
        "private"
    );
    for path in [
        "/executors/%2Fresources",
        "/executors/%252Fresources",
        "/executors/%5Cresources",
        "/executors/%FF",
        "/executors//revisions",
    ] {
        assert!(
            status(api.req(Method::GET, path, W))
                .await
                .is_client_error(),
            "{path}"
        );
    }
    assert_eq!(
        value(api.req(Method::GET, "/resources", A)).await,
        json!([])
    );
    assert_eq!(
        value(api.req(Method::GET, "/agent-backends", A)).await,
        json!([])
    );
    api.close().await;
}

#[tokio::test]
async fn first_valid_put_owns_id_across_races_and_restart() {
    let home = Home::new();
    let store = home.open();
    seed(&store);
    let api = Server::new(store.clone()).await;
    let path = format!("/executor-attempts/{ID}");
    let body = start_body();
    for owner in [A, W, R] {
        let mut work = body.clone();
        work["workPatchId"] = Value::Null;
        let mut flow = body.clone();
        flow.as_object_mut().unwrap().remove("executorRef");
        let mut missing = body.clone();
        missing["executorRef"]["revision"] = json!(9);
        for v in [
            work,
            flow,
            missing,
            json!({"executorRef":body["executorRef"]}),
        ] {
            assert!(
                status(api.req(Method::PUT, &path, owner).json(&v))
                    .await
                    .is_client_error()
            );
        }
    }
    let preview =
        json!({"previewDefinition":{"id":"draft"},"workInstruction":body["workInstruction"]});
    for owner in [W, R] {
        assert_eq!(
            status(api.req(Method::PUT, &path, owner).json(&preview)).await,
            StatusCode::FORBIDDEN
        );
    }
    let draft = format!("/executor-attempts/{}", Uuid::new_v4());
    assert!(
        status(api.req(Method::PUT, &draft, A).json(&preview))
            .await
            .is_success()
    );
    let legacy = Uuid::new_v4().to_string();
    store
        .update(|db| {
            db[ATTEMPTS][&legacy] = json!({"result":{}});
            Ok(())
        })
        .unwrap();
    for key in [A, W, R] {
        assert_eq!(
            status(
                api.req(Method::PUT, &format!("/executor-attempts/{legacy}"), key)
                    .json(&body)
            )
            .await,
            StatusCode::NOT_FOUND
        );
    }
    let (a, b) = tokio::join!(
        status(api.req(Method::PUT, &path, W).json(&body)),
        status(api.req(Method::PUT, &path, R).json(&body))
    );
    let (winner, loser) = match (a, b) {
        (StatusCode::OK, StatusCode::NOT_FOUND) => (W, R),
        (StatusCode::NOT_FOUND, StatusCode::OK) => (R, W),
        _ => panic!("{a} and {b}"),
    };
    drop(store);
    api.close().await;
    let api = Server::new(home.open()).await;
    for (method, suffix) in [
        (Method::GET, ""),
        (Method::PUT, ""),
        (Method::POST, "/cancel"),
    ] {
        // Axum decodes this UUID alias for both the policy and the handler.
        let route = format!("{}{suffix}", path.replacen("/aaaa", "/%61aaa", 1));
        for (key, expected) in [
            (winner, StatusCode::OK),
            (loser, StatusCode::NOT_FOUND),
            (A, StatusCode::NOT_FOUND),
        ] {
            assert_eq!(
                status(api.req(method.clone(), &route, key).json(&body)).await,
                expected
            );
        }
    }
    api.close().await;
}

#[tokio::test]
async fn platform_reopens_its_own_store_and_keeps_file_permissions() {
    let home = Home::new();
    // The execution backend has already published a terminal result.
    let store = home.open();
    let artifact = directories::allocate(
        &store,
        Default::default(),
        |root| {
            directories::fs::write(root, &["note".into()], b"finished", false)?;
            Ok(())
        },
        |db, dir| {
            directories::freeze(db, dir)?;
            db[OWNERS][ID] = json!("workbench");
            db[ATTEMPTS][ID] =
                json!({"result":{"attemptId":ID,"status":"succeeded","artifactDirectoryId":dir}});
            Ok(dir.to_owned())
        },
    )
    .unwrap();
    drop(store);
    let open = || {
        crate::work::application(
            home.0.clone(),
            Tokens::new(A.into(), W.into(), R.into()).unwrap(),
        )
    };
    let api = Server::serve(open().unwrap()).await;
    assert!(open().is_err());
    let config = value(
        api.req(Method::POST, "/patches/config", A)
            .json(&json!({"name":"saved"})),
    )
    .await;
    api.close().await;
    assert!(home.0.join("platform.json").is_file());
    assert!(!home.0.join("work.json").exists());
    assert!(Store::open(home.0.clone()).is_err());
    let api = Server::serve(open().unwrap()).await;
    assert_eq!(
        value(api.req(Method::GET, "/patches/config", A)).await,
        json!([config])
    );
    assert_eq!(
        status(api.req(Method::GET, "/patches/config", W)).await,
        StatusCode::FORBIDDEN
    );
    let config_path = format!("/patches/config/{}", config["id"].as_str().unwrap());
    assert_eq!(
        value(api.req(Method::GET, &config_path, W)).await,
        json!({"id":config["id"]})
    );
    assert_eq!(
        status(api.req(Method::GET, &config_path, R)).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        status(api.req(
            Method::GET,
            &format!("/patches/config/{}", Uuid::new_v4()),
            W
        ))
        .await,
        StatusCode::NOT_FOUND
    );
    let attempt = format!("/executor-attempts/{ID}");
    let file = format!("/directories/{artifact}/file?path=note");
    assert_eq!(
        value(api.req(Method::GET, &attempt, W)).await["artifactDirectoryId"],
        artifact
    );
    assert_eq!(
        api.req(Method::GET, &file, W)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "finished"
    );
    for other in [R, A] {
        for path in [&file, &attempt] {
            assert_eq!(
                status(api.req(Method::GET, path, other)).await,
                StatusCode::NOT_FOUND
            );
        }
    }
    api.close().await;
}

#[tokio::test]
async fn directories_separate_admin_files_from_collected_artifacts() {
    let home = Home::new();
    let store = home.open();
    let api = Server::new(store.clone()).await;
    let patch = value(
        api.req(Method::POST, "/patches/config", A)
            .json(&json!({"name":"config"})),
    )
    .await;
    let independent = value(api.req(Method::POST, "/directories", A).json(&json!({}))).await;
    for dir in [&independent["id"], &patch["directoryId"]] {
        let file = format!("/directories/{}/file?path=note", dir.as_str().unwrap());
        assert_eq!(
            status(api.req(Method::PUT, &file, A).body("config")).await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            api.req(Method::GET, &file, A)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "config"
        );
        assert_eq!(
            status(api.req(Method::GET, &file, W)).await,
            StatusCode::NOT_FOUND
        );
    }
    let dir = directories::allocate(
        &store,
        directories::Rules::default(),
        |root| {
            directories::fs::write(root, &["note".into()], b"artifact", false)?;
            Ok(())
        },
        |db, dir| {
            directories::freeze(db, dir)?;
            db[OWNERS][ID] = json!("workbench");
            db[ATTEMPTS][ID] =
                json!({"result":{"attemptId":ID,"status":"unverified","artifactDirectoryId":dir}});
            Ok(dir.to_owned())
        },
    )
    .unwrap();
    let base = format!("/directories/{dir}");
    let file = format!("{base}/file?path=note");
    assert_eq!(
        status(api.req(Method::GET, &file, W)).await,
        StatusCode::NOT_FOUND
    );
    store
        .update(|db| {
            db[ATTEMPTS][ID]["result"]["status"] = json!("succeeded");
            Ok(())
        })
        .unwrap();
    for path in [&base, &format!("{base}/tree"), &file] {
        for key in [A, R] {
            assert_eq!(
                status(api.req(Method::GET, path, key)).await,
                StatusCode::NOT_FOUND
            );
        }
        assert!(status(api.req(Method::GET, path, W)).await.is_success());
    }
    assert_eq!(
        api.req(Method::GET, &file, W)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "artifact"
    );
    assert!(
        status(api.req(Method::GET, &format!("{base}/file?path=..%2Fnote"), W))
            .await
            .is_client_error()
    );
    for key in [A, W, R] {
        assert!(
            status(api.req(Method::PUT, &file, key).body("overwrite"))
                .await
                .is_client_error()
        );
    }
    let list = value(api.req(Method::GET, "/directories", A)).await;
    assert_eq!(list.as_array().unwrap().len(), 2);
    assert!(!list.to_string().contains(&dir));
    api.close().await;
}
