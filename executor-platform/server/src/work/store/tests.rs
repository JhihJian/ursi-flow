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
fn upgrade_removes_only_dispatch_records_and_exclusively_owned_trees() {
    use std::os::unix::fs::symlink;
    let dir = Dir::new();
    let store = dir.open();
    let base = dir.0.join("directories");
    DirBuilder::new().mode(0o700).create(&base).unwrap();
    let [
        artifact,
        frozen,
        work,
        config,
        standalone,
        unknown,
        unregistered,
    ] = std::array::from_fn(|_| Uuid::new_v4().to_string());
    for id in [
        &artifact,
        &frozen,
        &work,
        &config,
        &standalone,
        &unknown,
        &unregistered,
    ] {
        fs::create_dir_all(base.join(id).join("sub")).unwrap();
        fs::write(base.join(id).join("sub/file"), id).unwrap();
    }
    for path in [base.join(&frozen).join("sub"), base.join(&frozen)] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o500)).unwrap();
    }
    symlink(base.join(&standalone), base.join(&artifact).join("link")).unwrap();
    let mut kept = json!({
        "catalog":{"resources":{"r":1},"executors":{"e":2},"other":true},
        "workPatches":{"p":{"directoryId":work}},"configPatches":{"p":{"directoryId":config}},
        "workListItems":{"i":{"title":"keep","category":"one_time","status":"active"}},"mcpServers":{"s":{}},
        "future":{"directory":unknown}, "attempts":{"unrelated":"keep"}
    });
    for id in [&work, &config, &standalone, &unknown] {
        kept["directories"][id] = json!({"id":id,"state":"frozen"});
    }
    kept["directories"]["../outside"] = json!({"id":"../outside"});
    let mut old = kept.clone();
    old["catalog"]["packages"] = json!({"p":{"revisions":[{}]}});
    old["directories"][&artifact] = json!({"id":artifact});
    old["directories"][&frozen] = json!({"id":frozen});
    old["items"]["i"] = json!({"deliveries":[{"files":{"report":"old"}}], "attempts":[
        {"artifactDirectory":{"id":artifact},"configPackage":{"snapshotRef":{"id":standalone}}},
        {"artifactDirectory":{"id":work}},{"artifactDirectory":{"id":unknown}},
        {"artifactDirectory":{"id":"../outside"}},{"artifactDirectory":{"id":unregistered}}
    ]});
    old["configPackageSnapshots"] =
        json!({"orphan":{"snapshotDirectoryId":frozen},"shared":{"snapshotDirectoryId":config}});
    fs::create_dir(dir.0.join("outside")).unwrap();
    store
        .update(|db| {
            *db = old;
            Ok(())
        })
        .unwrap();
    drop(store);
    assert_eq!(snapshot(&dir.open()), kept);
    assert_eq!(serde_json::from_slice::<Value>(&dir.bytes()).unwrap(), kept);
    for id in [&artifact, &frozen] {
        assert!(!base.join(id).exists());
    }
    for id in [&work, &config, &standalone, &unknown, &unregistered] {
        assert_eq!(
            fs::read_to_string(base.join(id).join("sub/file")).unwrap(),
            *id
        );
    }
    assert!(dir.0.join("outside").is_dir());
    assert_eq!(snapshot(&dir.open()), kept);
}

#[test]
fn upgrade_refuses_redirected_tree_and_retries_from_original_json() {
    use std::os::unix::fs::symlink;
    let dir = Dir::new();
    let store = dir.open();
    let first = "00000000-0000-4000-8000-000000000001";
    let second = "00000000-0000-4000-8000-000000000002";
    let base = dir.0.join("directories");
    DirBuilder::new().mode(0o700).create(&base).unwrap();
    fs::create_dir(base.join(first)).unwrap();
    let outside = dir.0.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep"), b"outside").unwrap();
    symlink(&outside, base.join(second)).unwrap();
    store
        .update(|db| {
            for id in [first, second] {
                db["directories"][id] = json!({"id":id});
                db["items"][id] = json!({"attempts":[{"artifactDirectory":{"id":id}}]});
            }
            Ok(())
        })
        .unwrap();
    drop(store);
    let before = dir.bytes();
    assert!(Store::open(dir.0.clone()).is_err());
    assert_eq!(dir.bytes(), before);
    assert!(!base.join(first).exists());
    assert_eq!(fs::read(outside.join("keep")).unwrap(), b"outside");
    fs::remove_file(base.join(second)).unwrap();
    assert_eq!(snapshot(&dir.open()), json!({"directories":{}}));
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
    let recovered = snapshot(&reopened);
    assert!(recovered.get("items").is_none());
    drop(reopened);
    assert_eq!(snapshot(&dir.open()), recovered);
}
