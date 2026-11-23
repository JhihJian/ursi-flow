use super::recover;
use crate::work::Store;
use serde_json::Value;
use uuid::Uuid;

fn store() -> (tempdir::Temp, Store) {
    let dir = tempdir::Temp(std::env::temp_dir().join(Uuid::new_v4().to_string()));
    let store = Store::open(dir.0.clone()).unwrap();
    (dir, store)
}

mod tempdir {
    pub struct Temp(pub std::path::PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[test]
fn splits_legacy_categories_strips_recipe_and_drops_generation_index() {
    let (_dir, store) = store();
    store
        .update(|db| {
            *db = serde_json::json!({
                "workListItems": {
                    "old": {"id":"old","title":"旧","category":"active","recipe":{"script":"s","resources":[]},"revision":1},
                    "keep": {"id":"keep","title":"新","category":"continuous","status":"active","generator":{"id":"g","revision":1},"revision":2}
                },
                "workListGenerations": {"old":{"retry":"p"}},
                "workPatches": {"p":{"id":"p"}}
            });
            Ok(())
        })
        .unwrap();
    recover(&store).unwrap();
    store
        .read(|db| {
            assert_eq!(
                db["workListItems"]["old"],
                serde_json::json!({"id":"old","title":"旧","category":"one_time","status":"active","revision":1})
            );
            assert_eq!(
                db["workListItems"]["keep"],
                serde_json::json!({"id":"keep","title":"新","category":"continuous","status":"active","revision":2})
            );
            assert!(db.get("workListGenerations").is_none());
            assert!(db.get("workPatches").is_some());
            Ok(())
        })
        .unwrap();
}

#[test]
fn rejects_invalid_legacy_category_and_keeps_store_closed() {
    let (_dir, store) = store();
    store
        .update(|db| {
            db["workListItems"]["bad"] =
                serde_json::json!({"id":"bad","title":"坏","category":"other"});
            Ok(())
        })
        .unwrap();
    assert!(recover(&store).is_err());
}
