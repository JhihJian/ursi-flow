use super::*;
use axum::{http::StatusCode, response::IntoResponse};

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("work-store-{}", Uuid::new_v4())))
    }
    fn open(&self) -> Store {
        Store::open(self.0.clone()).unwrap()
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(self.0.join("work.json")).unwrap()
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn snapshot(store: &Store) -> Value {
    store.read(|db| Ok(db.clone())).unwrap()
}

#[test]
fn open_resolves_relative_store_directory() {
    let relative = PathBuf::from(format!(".work-store-relative-{}", Uuid::new_v4()));
    let absolute = std::env::current_dir().unwrap().join(&relative);
    let store = Store::open(relative).unwrap();
    assert_eq!(store.dir(), absolute);
    drop(store);
    fs::remove_dir_all(absolute).unwrap();
}

#[test]
fn transaction_error_rolls_back_all_changes() {
    let dir = Dir::new();
    let store = dir.open();
    store
        .update(|db| {
            db["item"] = json!({"status":"queued"});
            Ok(())
        })
        .unwrap();
    let original = snapshot(&store);
    let bytes = dir.bytes();
    let result = store.update(|db| {
        db["item"]["status"] = "running".into();
        db["attempt"] = json!(1);
        Err::<(), _>(Error::Conflict("conflict".into()))
    });
    assert!(matches!(result, Err(Error::Conflict(_))));
    assert_eq!(snapshot(&store), original);
    assert_eq!(dir.bytes(), bytes);
    drop(store);
    assert_eq!(snapshot(&dir.open()), original);
}

#[test]
fn depth_limit_is_for_the_whole_persisted_database() {
    let dir = Dir::new();
    let store = dir.open();
    let mut payload = json!([]);
    for i in 1..126 {
        payload = if i % 2 == 0 {
            Value::Array(vec![payload])
        } else {
            Value::Object([("key".into(), payload)].into_iter().collect())
        };
    }
    store
        .update(|db| {
            db["payload"] = payload;
            Ok(())
        })
        .unwrap();
    let bytes = dir.bytes();
    let original = snapshot(&store);
    drop(store);
    let store = dir.open();
    assert_eq!(snapshot(&store), original);

    let result = store.update(|db| {
        let nested = db["payload"].take();
        db["payload"] = Value::Array(vec![nested]);
        assert!(
            serde_json::from_slice::<Value>(&serde_json::to_vec(&db["payload"]).unwrap()).is_ok()
        );
        assert!(serde_json::from_slice::<Value>(&serde_json::to_vec(db).unwrap()).is_err());
        Ok(())
    });
    assert!(matches!(result, Err(Error::Invalid(_))));
    assert_eq!(snapshot(&store), original);
    assert_eq!(dir.bytes(), bytes);
    drop(store);
    assert_eq!(snapshot(&dir.open()), original);
}

#[test]
fn independent_open_is_locked_until_last_handle_drops() {
    let dir = Dir::new();
    let store = dir.open();
    let clone = store.clone();
    drop(store);
    assert!(matches!(Store::open(dir.0.clone()), Err(e) if e.kind() == io::ErrorKind::WouldBlock));
    drop(clone);
    let _reopened = dir.open();
}

#[test]
fn directory_sync_failure_blocks_every_handle_until_restart_recovery() {
    let dir = Dir::new();
    let store = dir.open();
    let other = store.clone();
    let result = store.update_with_dir_sync(
        |db| {
            db["items"] = json!({"a":{"attempts":[{"status":"running"}]}});
            Ok(())
        },
        |path| {
            let renamed: Value = serde_json::from_reader(File::open(path.join("work.json"))?)?;
            assert_eq!(renamed["items"]["a"]["attempts"][0]["status"], "running");
            Err(io::Error::other("injected directory sync failure"))
        },
    );
    for err in [
        result.unwrap_err(),
        other
            .read::<()>(|_| panic!("read after failed sync"))
            .unwrap_err(),
        store
            .update::<()>(|_| panic!("update after failed sync"))
            .unwrap_err(),
    ] {
        assert_eq!(
            err.into_response().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    drop(other);
    drop(store);

    let reopened = dir.open();
    // Run the same recovery transaction as service startup, without dispatching any work.
    drop(super::super::execute::routes(
        reopened.clone(),
        dir.0.clone(),
        None,
    ));
    let recovered = snapshot(&reopened);
    let attempts = recovered["items"]["a"]["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0]["status"], "unverified");
    assert_eq!(attempts[0]["interruptedStatus"], "running");
    drop(reopened);
    assert_eq!(snapshot(&dir.open()), recovered);
}
