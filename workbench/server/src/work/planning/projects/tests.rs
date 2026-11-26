use super::*;
use reqwest::Method;
use std::{fs, path::PathBuf};
use tokio::{net::UnixListener, task::JoinHandle};

const ROOT: &str = "/api/v2";

struct Server {
    dir: PathBuf,
    process: JoinHandle<()>,
    client: reqwest::Client,
}

impl Server {
    fn start() -> Self {
        let dir = std::env::temp_dir().join(Uuid::new_v4().to_string());
        let process = Self::serve(&dir);
        let client = reqwest::Client::builder()
            .unix_socket(dir.join("http.sock"))
            .build()
            .unwrap();
        Self {
            dir,
            process,
            client,
        }
    }

    fn serve(dir: &std::path::Path) -> JoinHandle<()> {
        let store = Store::open(dir.join("work")).unwrap();
        let work = crate::work::business_routes(store).unwrap();
        let app = crate::transport::router(work, "planning-test".into());
        let listener = UnixListener::bind(dir.join("http.sock")).unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() })
    }

    async fn restart(&mut self) {
        self.process.abort();
        (&mut self.process).await.unwrap_err();
        fs::remove_file(self.dir.join("http.sock")).unwrap();
        self.process = Self::serve(&self.dir);
    }

    async fn call(&self, method: reqwest::Method, path: &str, body: Value, expected: u16) -> Value {
        let mut request = self
            .client
            .request(method.clone(), format!("http://localhost{ROOT}{path}"))
            .bearer_auth("planning-test");
        if !body.is_null() {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        assert_eq!(status.as_u16(), expected, "{method} {path}: {text}");
        if expected == 204 {
            assert!(text.is_empty());
        }
        if text.is_empty() || expected == 422 {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap()
        }
    }

    async fn get(&self, path: &str) -> Value {
        self.call(Method::GET, path, Value::Null, 200).await
    }

    async fn project(&self, name: &str) -> ProjectApi<'_> {
        let row = self
            .call(Method::POST, "/work-projects", json!({"name":name}), 200)
            .await;
        let path = format!("/work-projects/{}", id(&row));
        ProjectApi {
            server: self,
            path,
            revision: 1,
            row,
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.process.abort();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

struct ProjectApi<'a> {
    server: &'a Server,
    path: String,
    revision: u64,
    row: Value,
}

impl ProjectApi<'_> {
    async fn workspace(&self) -> Value {
        self.server.get(&format!("{}/workspace", self.path)).await
    }

    async fn command(&mut self, mut body: Value, status: u16) -> Value {
        if body.get("revision").is_none() {
            body["revision"] = json!(self.revision);
        }
        let reply = self
            .server
            .call(
                Method::POST,
                &format!("{}/commands", self.path),
                body,
                status,
            )
            .await;
        if status == 200 {
            self.revision += 1;
        }
        reply
    }

    async fn layout(
        &self,
        canvas: Option<&str>,
        revision: u64,
        positions: Value,
        status: u16,
    ) -> Value {
        self.server
            .call(
                Method::PUT,
                &format!("{}/layout", self.path),
                json!({"canvasId":canvas,"revision":revision,"positions":positions}),
                status,
            )
            .await
    }
}

fn id(row: &Value) -> &str {
    row["id"].as_str().unwrap()
}

#[tokio::test]
async fn workspace_and_placement_survive_restart_without_flow() {
    let mut server = Server::start();
    assert_eq!(server.get("/work-projects").await, json!([]));
    let unauthenticated = server
        .client
        .get("http://localhost/api/v2/work-projects")
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
    let mut project = server.project(" 客户交付 ").await;
    let project_id = id(&project.row).to_owned();
    assert_eq!(
        project.row,
        json!({"id":project_id,"name":"客户交付","revision":1})
    );
    assert_eq!(server.get("/work-projects").await, json!([project.row]));
    let initial = project.workspace().await;
    let first = id(&initial["canvases"][0]).to_owned();
    assert_eq!(
        initial,
        json!({
            "project":project.row,"canvases":[{"id":first,"name":"默认画布"}],"taskCards":[],"items":[],"relations":[],
            "layouts":{"map":{"revision":0,"positions":{}},"canvases":{(&first):{"revision":0,"positions":{}}}}
        })
    );
    let second = id(&project
        .command(json!({"type":"createCanvas","name":"验收"}), 200)
        .await)
    .to_owned();
    let card = id(&project
        .command(
            json!({"type":"createTaskCard","canvasId":second,"name":"检查"}),
            200,
        )
        .await)
    .to_owned();
    for (body, status) in [
        (
            json!({"type":"createItem","taskCardId":card,"title":"  "}),
            400,
        ),
        (
            json!({"type":"createItem","taskCardId":card,"title":"不应保存","status":"active"}),
            422,
        ),
        (
            json!({"type":"createItem","taskCardId":card,"title":"不应保存","category":null}),
            422,
        ),
        (
            json!({"type":"createItem","taskCardId":card,"title":"不应保存","revision":1}),
            409,
        ),
    ] {
        project.command(body, status).await;
    }
    assert_eq!(server.get("/work-items").await, json!([]));
    let item = id(&project.command(json!({"type":"createItem","taskCardId":card,"title":" 对照清单 ","category":"continuous","description":"逐项确认"}), 200).await).to_owned();
    let global = server
        .call(
            Method::POST,
            "/work-items",
            json!({"title":"保留签字页"}),
            200,
        )
        .await;
    let global_id = id(&global);
    assert_eq!(
        server
            .get(&format!("/work-items/{global_id}/placement"))
            .await,
        Value::Null
    );
    project
        .command(
            json!({"type":"placeItem","workItemId":global_id,"taskCardId":card}),
            200,
        )
        .await;
    for order in [json!([item]), json!([item, item]), json!([item, "outside"])] {
        project
            .command(
                json!({"type":"reorderItems","taskCardId":card,"itemIds":order}),
                400,
            )
            .await;
    }
    project
        .command(
            json!({"type":"reorderItems","taskCardId":card,"itemIds":[global_id,item]}),
            200,
        )
        .await;
    let edge = id(&project
        .command(
            json!({"type":"createRelation","canvasId":null,"from":first,"to":second}),
            200,
        )
        .await)
    .to_owned();
    let map = project
        .layout(None, 0, json!({(&second):{"x":12.5,"y":-7.0}}), 200)
        .await;
    let details = server
        .call(
            Method::PUT,
            &format!("/work-items/{item}"),
            json!({"title":"对照清单","description":"逐项确认","status":"completed","revision":1}),
            200,
        )
        .await;
    assert_eq!(
        details,
        json!({"id":item,"title":"对照清单","description":"逐项确认","status":"completed","category":"continuous","revision":2})
    );
    let workspace = project.workspace().await;
    assert_eq!(workspace["project"]["revision"], project.revision);
    assert_eq!(
        workspace["canvases"],
        json!([{"id":first,"name":"默认画布"},{"id":second,"name":"验收"}])
    );
    assert_eq!(
        workspace["taskCards"],
        json!([{"id":card,"canvasId":second,"name":"检查"}])
    );
    assert_eq!(
        workspace["items"],
        json!([{"item":global,"taskCardId":card,"rank":0},{"item":details,"taskCardId":card,"rank":1}])
    );
    assert_eq!(
        workspace["relations"],
        json!([{"id":edge,"canvasId":null,"from":first,"to":second}])
    );
    assert_eq!(workspace["layouts"]["map"], map);
    let path = project.path.clone();
    server.restart().await;
    assert_eq!(server.get(&format!("{path}/workspace")).await, workspace);
    assert_eq!(
        server.get(&format!("/work-items/{item}/placement")).await,
        json!({"projectId":project_id,"canvasId":second,"taskCardId":card})
    );
    assert_eq!(server.get(&format!("/work-items/{item}")).await, details);
    assert_eq!(server.get("/work-patch-generation-runs").await, json!([]));
    server
        .call(
            Method::GET,
            "/work-items/missing/placement",
            Value::Null,
            404,
        )
        .await;
}

#[tokio::test]
async fn rejects_cross_project_claims_and_cleans_up_old_item_deletion() {
    let server = Server::start();
    let mut project = server.project("来源").await;
    let mut other = server.project("目标").await;
    let canvas = id(&project.workspace().await["canvases"][0]).to_owned();
    let other_canvas = id(&other.workspace().await["canvases"][0]).to_owned();
    let card = id(&project
        .command(
            json!({"type":"createTaskCard","canvasId":canvas,"name":"处理"}),
            200,
        )
        .await)
    .to_owned();
    let item = id(&project
        .command(
            json!({"type":"createItem","taskCardId":card,"title":"接收"}),
            200,
        )
        .await)
    .to_owned();
    let next = id(&project
        .command(
            json!({"type":"createItem","taskCardId":card,"title":"存档"}),
            200,
        )
        .await)
    .to_owned();
    let other_card = id(&other
        .command(
            json!({"type":"createTaskCard","canvasId":other_canvas,"name":"验收"}),
            200,
        )
        .await)
    .to_owned();
    let patch = server
        .call(
            Method::POST,
            "/patches/work",
            json!({"name":"文件","workItemId":item}),
            200,
        )
        .await;
    let patch_path = format!("/patches/work/{}", id(&patch));
    let snapshot = project.workspace().await;
    project
        .command(json!({"type":"deleteTaskCard","taskCardId":card}), 409)
        .await;
    project
        .command(json!({"type":"deleteCanvas","canvasId":canvas}), 409)
        .await;
    server
        .call(Method::DELETE, &project.path, Value::Null, 409)
        .await;
    other
        .command(
            json!({"type":"placeItem","workItemId":item,"taskCardId":other_card}),
            409,
        )
        .await;
    project
        .command(
            json!({"type":"placeItem","workItemId":item,"taskCardId":other_card}),
            404,
        )
        .await;
    project
        .command(json!({"type":"placeItem","workItemId":item}), 422)
        .await;
    assert_eq!(project.workspace().await, snapshot);
    let alt_canvas = id(&project
        .command(json!({"type":"createCanvas","name":"另一张图"}), 200)
        .await)
    .to_owned();
    let alt = id(&project
        .command(
            json!({"type":"createTaskCard","canvasId":alt_canvas,"name":"另一张卡"}),
            200,
        )
        .await)
    .to_owned();
    project
        .command(
            json!({"type":"placeItem","workItemId":next,"taskCardId":alt}),
            200,
        )
        .await;
    assert_eq!(
        server.get(&format!("/work-items/{next}/placement")).await["canvasId"],
        alt_canvas
    );
    project
        .command(
            json!({"type":"placeItem","workItemId":next,"taskCardId":null}),
            200,
        )
        .await;
    assert_eq!(
        server.get(&format!("/work-items/{next}/placement")).await,
        Value::Null
    );
    other
        .command(
            json!({"type":"placeItem","workItemId":next,"taskCardId":other_card}),
            200,
        )
        .await;
    other
        .command(
            json!({"type":"placeItem","workItemId":next,"taskCardId":null}),
            200,
        )
        .await;
    project
        .command(
            json!({"type":"placeItem","workItemId":next,"taskCardId":card}),
            200,
        )
        .await;
    assert_eq!(project.workspace().await["items"][1]["rank"], 1);
    assert_eq!(server.get(&patch_path).await["workItemId"], item);
    server
        .call(
            Method::DELETE,
            &format!("/work-items/{item}"),
            Value::Null,
            204,
        )
        .await;
    let after = project.workspace().await;
    assert_eq!(after["project"]["revision"], project.revision + 1);
    assert_eq!(after["items"][0]["item"]["id"], next);
    assert_eq!(after["items"][0]["item"]["revision"], 1);
    assert_eq!(after["items"][0]["rank"], 0);
    let mut expected_patch = patch;
    expected_patch["workItemId"] = Value::Null;
    assert_eq!(server.get(&patch_path).await, expected_patch);
    let rename = json!({"name":"新名称","revision":project.revision});
    server.call(Method::PUT, &project.path, rename, 409).await;
    project.revision += 1;
    let renamed = server
        .call(
            Method::PUT,
            &project.path,
            json!({"name":"新名称","revision":project.revision}),
            200,
        )
        .await;
    project.revision += 1;
    assert_eq!(
        renamed,
        json!({"id":id(&project.row),"name":"新名称","revision":project.revision})
    );
    project
        .command(
            json!({"type":"placeItem","workItemId":next,"taskCardId":null}),
            200,
        )
        .await;
    server
        .call(Method::DELETE, &project.path, Value::Null, 204)
        .await;
    server
        .call(
            Method::GET,
            &format!("{}/workspace", project.path),
            Value::Null,
            404,
        )
        .await;
    assert_eq!(
        server.get(&format!("/work-items/{next}")).await["title"],
        "存档"
    );
}

#[tokio::test]
async fn item_delete_rolls_back_when_package_detach_fails() {
    let dir = std::env::temp_dir().join(Uuid::new_v4().to_string());
    let store = Store::open(dir.clone()).unwrap();
    let project = create(
        State(store.clone()),
        Json(Create {
            name: "回滚".into(),
        }),
    )
    .await
    .unwrap()
    .0;
    let project_id = id(&project);
    let initial = workspace(State(store.clone()), Path(project_id.into()))
        .await
        .unwrap()
        .0;
    let canvas = id(&initial["canvases"][0]);
    let card = command(
        State(store.clone()),
        Path(project_id.into()),
        Json(CommandRequest {
            revision: 1,
            command: Command::CreateTaskCard {
                canvas_id: canvas.into(),
                name: "整理".into(),
            },
        }),
    )
    .await
    .unwrap()
    .0;
    let item = command(
        State(store.clone()),
        Path(project_id.into()),
        Json(CommandRequest {
            revision: 2,
            command: Command::CreateItem {
                task_card_id: id(&card).into(),
                title: "原事项".into(),
                description: String::new(),
                category: None,
            },
        }),
    )
    .await
    .unwrap()
    .0;
    store
        .update(|db| {
            db["workPatches"] = json!([]);
            Ok(())
        })
        .unwrap();
    let before = store.read(|db| Ok(db.clone())).unwrap();
    assert!(matches!(
        items::remove(State(store.clone()), Path(id(&item).into())).await,
        Err(Error::Internal(_))
    ));
    assert_eq!(store.read(|db| Ok(db.clone())).unwrap(), before);
    drop(store);
    fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn enforces_graph_scope_and_revisions_and_cleans_both_layout_levels() {
    let server = Server::start();
    let mut project = server.project("两级图").await;
    let a = id(&project.workspace().await["canvases"][0]).to_owned();
    project
        .command(json!({"type":"deleteCanvas","canvasId":a}), 409)
        .await;
    let b = id(&project
        .command(json!({"type":"createCanvas","name":"二"}), 200)
        .await)
    .to_owned();
    let c = id(&project
        .command(json!({"type":"createCanvas","name":"三"}), 200)
        .await)
    .to_owned();
    let x = id(&project
        .command(
            json!({"type":"createTaskCard","canvasId":a,"name":"甲"}),
            200,
        )
        .await)
    .to_owned();
    let y = id(&project
        .command(
            json!({"type":"createTaskCard","canvasId":a,"name":"乙"}),
            200,
        )
        .await)
    .to_owned();
    let z = id(&project
        .command(
            json!({"type":"createTaskCard","canvasId":b,"name":"丙"}),
            200,
        )
        .await)
    .to_owned();
    let ab = id(&project
        .command(
            json!({"type":"createRelation","canvasId":null,"from":a,"to":b}),
            200,
        )
        .await)
    .to_owned();
    let bc = id(&project
        .command(
            json!({"type":"createRelation","canvasId":null,"from":b,"to":c}),
            200,
        )
        .await)
    .to_owned();
    let xy = id(&project
        .command(
            json!({"type":"createRelation","canvasId":a,"from":x,"to":y}),
            200,
        )
        .await)
    .to_owned();
    let snapshot = project.workspace().await;
    for (scope, from, to) in [
        (None, &a, &b),
        (None, &a, &a),
        (None, &c, &a),
        (None, &x, &b),
        (Some(a.as_str()), &x, &z),
        (Some(b.as_str()), &x, &y),
    ] {
        project
            .command(
                json!({"type":"createRelation","canvasId":scope,"from":from,"to":to}),
                400,
            )
            .await;
    }
    project
        .command(
            json!({"type":"replaceRelation","relationId":ab,"from":c,"to":b}),
            400,
        )
        .await;
    project
        .command(
            json!({"type":"replaceRelation","relationId":ab,"from":b,"to":c}),
            400,
        )
        .await;
    project
        .command(
            json!({"type":"replaceRelation","relationId":xy,"from":z,"to":y}),
            400,
        )
        .await;
    project
        .command(json!({"type":"createRelation","from":a,"to":c}), 422)
        .await;
    project
        .layout(Some(&a), 0, json!({(&z):{"x":4,"y":5}}), 400)
        .await;
    project
        .layout(None, 0, json!({(&x):{"x":4,"y":5}}), 400)
        .await;
    assert_eq!(project.workspace().await, snapshot);
    project
        .command(
            json!({"type":"replaceRelation","relationId":ab,"from":b,"to":a}),
            200,
        )
        .await;
    project
        .command(json!({"type":"deleteRelation","relationId":bc}), 200)
        .await;
    project
        .command(
            json!({"type":"renameCanvas","canvasId":b,"name":"第二画布"}),
            200,
        )
        .await;
    project
        .command(
            json!({"type":"renameTaskCard","taskCardId":x,"name":"首张卡"}),
            200,
        )
        .await;
    let changed = project.workspace().await;
    assert_eq!(changed["canvases"][1], json!({"id":b,"name":"第二画布"}));
    assert_eq!(
        changed["taskCards"][0],
        json!({"id":x,"canvasId":a,"name":"首张卡"})
    );
    assert_eq!(
        changed["relations"][0],
        json!({"id":ab,"canvasId":null,"from":b,"to":a})
    );
    let desk = json!({(&b):{"x":4.0,"y":5.0},(&c):{"x":9.0,"y":8.0}});
    let card_positions = json!({(&x):{"x":1.0,"y":2.0},(&y):{"x":3.0,"y":4.0}});
    assert_eq!(
        project.layout(None, 0, desk.clone(), 200).await,
        json!({"revision":1,"positions":desk})
    );
    project.layout(None, 0, json!({}), 409).await;
    project
        .layout(Some(&a), 0, card_positions.clone(), 200)
        .await;
    project
        .layout(Some(&b), 0, json!({(&z):{"x":0,"y":0}}), 200)
        .await;
    assert_eq!(
        project.workspace().await["project"]["revision"],
        project.revision
    );
    project
        .command(json!({"type":"deleteTaskCard","taskCardId":x}), 200)
        .await;
    project.layout(Some(&a), 1, card_positions, 409).await;
    project
        .command(json!({"type":"deleteCanvas","canvasId":b}), 200)
        .await;
    project.layout(None, 1, desk, 409).await;
    let after = project.workspace().await;
    assert_eq!(after["relations"], json!([]));
    assert_eq!(
        after["taskCards"],
        json!([{"id":y,"canvasId":a,"name":"乙"}])
    );
    assert_eq!(
        after["layouts"]["canvases"][&a],
        json!({"revision":2,"positions":{(&y):{"x":3.0,"y":4.0}}})
    );
    assert!(after["layouts"]["canvases"].get(&b).is_none());
    assert_eq!(
        after["layouts"]["map"],
        json!({"revision":2,"positions":{(&c):{"x":9.0,"y":8.0}}})
    );
    assert_eq!(
        project.layout(None, 2, json!({}), 200).await,
        json!({"revision":3,"positions":{}})
    );
}
