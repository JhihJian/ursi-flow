use super::*;

struct Temp(std::path::PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn fixture() -> (Temp, Service) {
    let temp = Temp(std::env::temp_dir().join(Uuid::new_v4().to_string()));
    let store = Store::open(temp.0.clone()).unwrap();
    store.update(|db| {
        db["catalog"][generators::GENERATORS]["g"] = json!({"active":true,"revisions":[{"id":"g","name":"测试","revision":1,"aliases":[],"script":"unused"}]});
        db["workListItems"]["item"] = json!({"id":"item","title":"标题","revision":1,"category":"one_time","status":"pending","generator":{"id":"g","revision":1,"resources":[]}});
        Ok(())
    }).unwrap();
    let platform = crate::work::mcp::platform(&store);
    (
        temp,
        Service {
            store,
            platform,
            slots: Arc::new(Semaphore::new(1)),
        },
    )
}
fn bound() -> Request {
    Request::WorkItem(WorkItem {
        work_item_id: "item".into(),
    })
}
fn trial() -> Request {
    Request::Trial(Trial {
        generator: GeneratorRef {
            id: "g".into(),
            revision: 1,
        },
        resources: vec![],
    })
}
fn generated() -> convert::Generated {
    convert::Generated {
        name: "包名".into(),
        files: vec![("a.txt".into(), b"example".to_vec())],
        provenance: json!({"resources":[]}),
    }
}

#[test]
fn concurrent_admission_replays_and_restart_closes_unfinished_run() {
    let (temp, service) = fixture();
    let id = Uuid::new_v4().to_string();
    let (first, second) = std::thread::scope(|scope| {
        let one = scope.spawn(|| register(&service, &id, bound()).unwrap());
        let two = register(&service, &id, bound()).unwrap();
        (one.join().unwrap(), two)
    });
    assert_eq!(first.0, second.0);
    assert_eq!(first.0["initiator"], "workbench-admin");
    assert_ne!(first.1.is_some(), second.1.is_some());
    assert!(matches!(
        register(&service, &id, trial()),
        Err(Error::Conflict(_))
    ));
    drop((first, second, service));
    let mut reopened = Store::open(temp.0.clone());
    // A parallel subprocess test can transiently inherit the lock between fork and exec.
    for _ in 0..50 {
        if !matches!(&reopened, Err(e) if e.kind() == std::io::ErrorKind::WouldBlock) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
        reopened = Store::open(temp.0.clone());
    }
    let store = reopened.unwrap();
    recover(&store).unwrap();
    let service = Service {
        platform: crate::work::mcp::platform(&store),
        store: store.clone(),
        slots: Arc::new(Semaphore::new(1)),
    };
    let (replay, job) = register(&service, &id, bound()).unwrap();
    assert!(job.is_none());
    assert_eq!(replay["status"], "interrupted");
    store
        .read(|db| {
            assert_eq!(db[RUNS][&id]["run"]["status"], "interrupted");
            assert!(db["workPatches"].is_null());
            Ok(())
        })
        .unwrap();
}

#[test]
fn bound_publication_checks_revision_and_persists_link_after_detach() {
    let (temp, service) = fixture();
    let id = Uuid::new_v4().to_string();
    let (_, job) = register(&service, &id, bound()).unwrap();
    let job = job.unwrap();
    service
        .store
        .update(|db| {
            db["workListItems"]["item"]["revision"] = json!(2);
            Ok(())
        })
        .unwrap();
    assert!(matches!(
        publish(&service.store, &job, generated()),
        Err(Error::Conflict(_))
    ));
    assert_eq!(temp.0.join("directories").read_dir().unwrap().count(), 0);
    drop(job);
    let next = Uuid::new_v4().to_string();
    let (_, job) = register(&service, &next, bound()).unwrap();
    publish(&service.store, &job.unwrap(), generated()).unwrap();
    service
        .store
        .update(|db| {
            db["workListItems"].as_object_mut().unwrap().remove("item");
            patches::detach_item(db, "item")
        })
        .unwrap();
    let (row, replay) = register(&service, &next, bound()).unwrap();
    assert!(replay.is_none());
    assert_eq!(row["workItemId"], "item");
    service
        .store
        .read(|db| {
            let patch = &db["workPatches"][row["result"]["workPatchId"].as_str().unwrap()];
            assert_eq!(patch["provenance"]["runId"], next);
            assert!(patch["workItemId"].is_null());
            assert_eq!(row["result"]["files"][0]["bytes"], 7);
            Ok(())
        })
        .unwrap();
}

#[test]
fn trial_freezes_directory_without_publishing_package() {
    let (_temp, service) = fixture();
    let id = Uuid::new_v4().to_string();
    let (_, job) = register(&service, &id, trial()).unwrap();
    publish(&service.store, &job.unwrap(), generated()).unwrap();
    service
        .store
        .read(|db| {
            let row = &db[RUNS][&id]["run"];
            assert_eq!(row["status"], "succeeded");
            assert!(row.get("workItemId").is_none());
            assert!(db["workPatches"].is_null());
            assert_eq!(
                db["directories"][row["result"]["directoryId"].as_str().unwrap()]["state"],
                "frozen"
            );
            Ok(())
        })
        .unwrap();
}
