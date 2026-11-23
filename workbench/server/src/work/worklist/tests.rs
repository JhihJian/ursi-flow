use super::*;
use std::{fs, path::PathBuf};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(Uuid::new_v4().to_string()))
    }
    fn open(&self) -> Store {
        Store::open(self.0.clone()).unwrap()
    }
    fn directory_count(&self) -> usize {
        self.0.join("directories").read_dir().unwrap().count()
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn input(value: Value) -> Json<Definition> {
    Json(serde_json::from_value(value).unwrap())
}
#[tokio::test]
async fn crud_persists_filters_and_checks_revisions() {
    let temp = Temp::new();
    let store = temp.open();
    let row = create(State(store.clone()), input(json!({"title":"  事项  "})))
        .await
        .unwrap()
        .0;
    let id = row["id"].as_str().unwrap().to_owned();
    assert_eq!(
        row,
        json!({"id":id,"title":"事项","category":"one_time","status":"pending","revision":1,"description":""})
    );
    let path = || Path(id.clone());
    let draft = json!({"title":"事项","revision":1,"category":"continuous","status":"active"});
    let updated = replace(State(store.clone()), path(), input(draft.clone()))
        .await
        .unwrap()
        .0;
    assert_eq!(updated["revision"], 2);
    assert!(matches!(
        replace(State(store.clone()), path(), input(draft.clone())).await,
        Err(Error::Conflict(_))
    ));
    let mut same = draft.clone();
    same["revision"] = json!(2);
    assert_eq!(
        replace(State(store.clone()), path(), input(same))
            .await
            .unwrap()
            .0,
        updated
    );
    assert!(
        serde_json::from_value::<Definition>(json!({"title":"test","category":"other"})).is_err()
    );
    drop(store);
    let store = temp.open();
    for (category, expected) in [
        (Category::OneTime, json!([])),
        (Category::Continuous, json!([updated])),
    ] {
        assert_eq!(
            list(
                State(store.clone()),
                Query(Filter {
                    category: Some(category),
                    status: None,
                })
            )
            .await
            .unwrap()
            .0,
            expected
        );
    }
    assert_eq!(
        detail(State(store.clone()), path()).await.unwrap().0,
        updated
    );
    assert_eq!(
        remove(State(store.clone()), path()).await.unwrap(),
        StatusCode::NO_CONTENT
    );
    assert!(matches!(
        detail(State(store), path()).await,
        Err(Error::NotFound(_))
    ));
}

#[tokio::test]
async fn all_six_combinations_support_both_filters() {
    let temp = Temp::new();
    let store = temp.open();
    for category in ["one_time", "continuous"] {
        for status in ["pending", "active", "completed"] {
            let row = create(
                State(store.clone()),
                input(json!({"title":"事项", "category":category})),
            )
            .await
            .unwrap()
            .0;
            assert_eq!(row["status"], "pending");
            let updated = replace(
                State(store.clone()),
                Path(row["id"].as_str().unwrap().into()),
                input(json!({"title":"事项","status":status})),
            )
            .await
            .unwrap()
            .0;
            assert_eq!(updated["category"], category);
            assert_eq!(updated["status"], status);
        }
    }
    for category in [None, Some("one_time"), Some("continuous")] {
        for status in [None, Some("pending"), Some("active"), Some("completed")] {
            let filter =
                serde_json::from_value(json!({"category":category,"status":status})).unwrap();
            let rows = list(State(store.clone()), Query(filter)).await.unwrap().0;
            let rows = rows.as_array().unwrap();
            assert_eq!(
                rows.len(),
                (if category.is_none() { 2 } else { 1 }) * (if status.is_none() { 3 } else { 1 })
            );
            assert!(
                rows.iter()
                    .all(|r| category.is_none_or(|v| r["category"] == v)
                        && status.is_none_or(|v| r["status"] == v))
            );
        }
    }
}

#[tokio::test]
async fn omitted_dimensions_keep_their_values_on_update() {
    let temp = Temp::new();
    let store = temp.open();
    let row = create(
        State(store.clone()),
        input(json!({"title":"事项", "category":"continuous"})),
    )
    .await
    .unwrap()
    .0;
    let path = || Path(row["id"].as_str().unwrap().to_owned());
    for (fields, category, status, revision) in [
        (
            json!({"title":"事项", "category":"one_time"}),
            "one_time",
            "pending",
            2,
        ),
        (
            json!({"title":"事项", "category":"continuous"}),
            "continuous",
            "pending",
            3,
        ),
        (
            json!({"title":"事项", "status":"active"}),
            "continuous",
            "active",
            4,
        ),
        (json!({"title":"事项"}), "continuous", "active", 4),
    ] {
        let updated = replace(State(store.clone()), path(), input(fields))
            .await
            .unwrap()
            .0;
        assert_eq!(updated["category"], category);
        assert_eq!(updated["status"], status);
        assert_eq!(updated["revision"], revision);
    }
}

#[tokio::test]
async fn create_rejects_client_status() {
    let temp = Temp::new();
    let store = temp.open();
    for status in ["pending", "active", "completed"] {
        assert!(matches!(
            create(
                State(store.clone()),
                input(json!({"title":"事项", "status":status}))
            )
            .await,
            Err(Error::Invalid(_))
        ));
    }
    assert!(store.read(|db| Ok(db.get(TABLE).is_none())).unwrap());
}

#[test]
fn rejects_legacy_or_invalid_dimensions() {
    for (field, invalid) in [
        ("category", "pending"),
        ("category", "active"),
        ("category", "completed"),
        ("status", "continuous"),
        ("status", "other"),
    ] {
        assert!(
            serde_json::from_value::<Definition>(json!({"title":"事项", field:invalid})).is_err()
        );
        assert!(serde_json::from_value::<Filter>(json!({field:invalid})).is_err());
    }
    for field in ["category", "status"] {
        assert!(serde_json::from_value::<Definition>(json!({"title":"事项", field:null})).is_err());
    }
}

