use super::*;
use reqwest::StatusCode;

fn body() -> Value {
    json!({"id":"例.g-1", "name":" 新名称 ", "aliases":["输入"], "script":"# source\n"})
}

#[test]
fn validation_preserves_byte_and_character_limits() {
    let mut db = json!({});
    for (field, invalid) in [
        ("id", json!("new")),
        ("id", json!("a/b")),
        ("id", json!("..")),
        ("id", json!("x".repeat(129))),
        ("name", json!("名".repeat(81))),
        ("name", json!("a\nb")),
        ("aliases", Value::Null),
        ("aliases", json!(["输入", "输入"])),
        ("aliases", json!([" 输入"])),
        ("aliases", json!(["x".repeat(129)])),
        (
            "aliases",
            json!((0..33).map(|i| i.to_string()).collect::<Vec<_>>()),
        ),
        ("script", json!(" \n")),
        ("script", json!("é".repeat(32769))),
        ("revision", json!(42)),
    ] {
        let mut invalid_body = body();
        invalid_body[field] = invalid;
        assert!(
            matches!(publish(&mut db, &invalid_body), Err(Error::Invalid(_))),
            "{field}"
        );
    }
    assert_eq!(db, json!({}));
    let mut valid = body();
    valid["name"] = json!("名".repeat(80));
    valid["aliases"] = json!(["é".repeat(64)]);
    valid["script"] = json!("é".repeat(32768));
    assert_eq!(publish(&mut db, &valid).unwrap()["revision"], 1);
}

#[test]
fn inactive_record_remains_readable_but_cannot_be_bound_or_revised() {
    let mut db = json!({});
    let first = publish(&mut db, &body()).unwrap();
    let id = first["id"].as_str().unwrap();
    db["catalog"][GENERATORS][id]["active"] = false.into();
    assert_eq!(version(&db, id, 1).unwrap(), &first);
    assert_eq!(latest(record(&db, id).unwrap()).unwrap()["active"], false);
    assert!(matches!(generator(&db, id, 1), Err(Error::Conflict(_))));
    assert!(matches!(publish(&mut db, &body()), Err(Error::Conflict(_))));
}

#[tokio::test]
async fn http_appends_to_existing_history_without_platform_routes() {
    let dir = std::env::temp_dir().join(format!("generator-test-{}", uuid::Uuid::new_v4()));
    let store = Store::open(dir.clone()).unwrap();
    let first = json!({"id":"g","name":"旧名称","aliases":[],"script":"old", "revision":1});
    store.update(|db| {
        db["catalog"] = json!({"work-patch-generators":{"g":{"active":true,"revisions":[first]}},"executors":{"preserved":true}});
        Ok(())
    }).unwrap();
    let app = routes(store.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::new();
    let base = format!("http://{addr}/v2/work-patch-generators");
    let mut body = body();
    body["id"] = "g".into();
    let mut invalid = body.clone();
    invalid["backendId"] = "pi".into();
    assert_eq!(
        client
            .post(&base)
            .json(&invalid)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let published = client.post(&base).json(&body).send().await.unwrap();
    assert_eq!(published.status(), StatusCode::OK);
    let revised: Value = published.json().await.unwrap();
    body["name"] = "新名称".into();
    body["revision"] = 2.into();
    assert_eq!(revised, body);
    let mut current = revised.clone();
    current["active"] = true.into();
    for (suffix, expected) in [
        ("", json!([current])),
        ("/g", current),
        ("/g/revisions", json!([first, revised])),
        ("/g/revisions/1", first.clone()),
    ] {
        let resp = client.get(format!("{base}{suffix}")).send().await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.json::<Value>().await.unwrap(), expected);
    }
    for (suffix, status) in [
        ("/g/revisions/0", StatusCode::BAD_REQUEST),
        ("/g/revisions/3", StatusCode::NOT_FOUND),
        ("/missing", StatusCode::NOT_FOUND),
    ] {
        assert_eq!(
            client
                .get(format!("{base}{suffix}"))
                .send()
                .await
                .unwrap()
                .status(),
            status
        );
    }
    assert_eq!(
        client
            .post(format!("{base}/g/deactivate"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .get(format!("http://{addr}/v2/executors"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    store
        .read(|db| {
            assert_eq!(generator(db, "g", 1)?, &first);
            assert_eq!(db["catalog"]["executors"], json!({"preserved":true}));
            Ok(())
        })
        .unwrap();
    server.abort();
    let _ = server.await;
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
