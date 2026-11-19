use super::{Error, model::*};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn body<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}
fn params(key: &str) -> Value {
    json!({"requestId":key,"package":"triage","revision":1,"input":{"ticket":key}})
}
fn new(db: &mut Value, key: &str) -> String {
    create(db, body(params(key)), |_, p, r| {
        Ok(json!({"id":p,"revision":r,"acceptance":"原因可核查"}))
    })
    .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn begin(item: &mut Value) {
    start(item, body(json!({"assignee":"Lin"}))).unwrap();
}
fn report(text: &str) -> Delivery {
    body(json!({"files":{"report.txt":text}}))
}
fn verdict(decision: &str, comment: &str) -> Review {
    body(json!({"reviewer":"Chen","decision":decision,"comment":comment}))
}

#[test]
fn replay_returns_original_item_even_if_package_is_disabled() {
    let mut db = json!({"catalog":{"unchanged":true}});
    let id = new(&mut db, "101");
    begin(item_mut(&mut db, &id).unwrap());
    let replay = |db: &mut Value, req| {
        create(db, body(req), |_, _, _| {
            panic!("must not resolve on replay")
        })
    };
    assert_eq!(
        replay(&mut db, params("101")).unwrap(),
        *item(&db, &id).unwrap()
    );
    for (field, value) in [
        ("package", json!("other")),
        ("revision", json!(2)),
        ("input", json!({})),
        ("source", json!({"type":"connector","id":"2"})),
    ] {
        let mut changed = params("101");
        changed[field] = value;
        assert!(matches!(replay(&mut db, changed), Err(Error::Conflict(_))));
    }
    assert_eq!(db["items"].as_object().unwrap().len(), 1);
    assert_eq!(db["catalog"], json!({"unchanged":true}));
    assert_eq!(db["items"][&id]["assignee"], "Lin");
}

#[test]
fn unresolved_package_leaves_empty_store_untouched() {
    let mut db = json!({});
    assert_eq!(list(&db, None).unwrap(), json!([]));
    assert!(matches!(
        create(&mut db, body(params("T")), |_, _, _| Err(Error::NotFound(
            "package".into()
        ))),
        Err(Error::NotFound(_))
    ));
    assert_eq!(db, json!({}));
}

#[test]
fn create_rejects_missing_and_mistyped_inputs_without_claiming_request_id() {
    let mut db = json!({});
    new(&mut db, "existing");
    let before = db.clone();
    let snapshot = json!({"inputs":{"ticket":"string","cost":"number","count":"integer",
        "done":"boolean","tags":"array","meta":"object"}});
    let valid = json!({"ticket":"A","cost":1.5,"count":u64::MAX,"done":false,
        "tags":[],"meta":{},"extra":"other material"});
    let submit = |db: &mut Value, input| {
        let mut req = params("same-key");
        req["input"] = input;
        create(db, body(req), |_, _, _| Ok(snapshot.clone()))
    };
    for (key, value) in [
        ("ticket", json!({"text":"A"})),
        ("cost", json!("1.5")),
        ("count", json!(1.5)),
        ("done", json!(0)),
        ("tags", json!(null)),
        ("meta", json!([])),
    ] {
        let mut input = valid.clone();
        input[key] = value;
        assert!(matches!(submit(&mut db, input), Err(Error::Invalid(_))));
        assert_eq!(db, before);
    }
    let mut missing = valid.clone();
    missing.as_object_mut().unwrap().remove("done");
    assert!(matches!(submit(&mut db, missing), Err(Error::Invalid(_))));
    assert_eq!(db, before);
    assert_eq!(submit(&mut db, valid.clone()).unwrap()["input"], valid);
}

#[test]
fn stale_review_cannot_accept_resubmission_and_both_histories_survive_reload() {
    let mut db = json!({});
    let a = new(&mut db, "A");
    let b = new(&mut db, "B");
    let first = item_mut(&mut db, &a).unwrap();
    begin(first);
    deliver(first, report("A 最终报告")).unwrap();
    review(first, 1, verdict("accept", "已核查")).unwrap();
    let second = item_mut(&mut db, &b).unwrap();
    begin(second);
    deliver(second, report("B 初稿")).unwrap();
    assert!(matches!(
        review(second, 1, verdict("reject", " ")),
        Err(Error::Invalid(_))
    ));
    review(second, 1, verdict("reject", "补充验证结果")).unwrap();
    assert_eq!(second["status"], "working");
    assert!(matches!(
        review(second, 1, verdict("accept", "")),
        Err(Error::Conflict(_))
    ));
    deliver(second, report("B 含验证结果")).unwrap();
    let before = second.clone();
    assert!(matches!(
        review(second, 1, verdict("accept", "")),
        Err(Error::Conflict(_))
    ));
    assert_eq!(*second, before);
    assert_eq!(list(&db, Some("review")).unwrap()[0]["id"], b);
    let mut db: Value = serde_json::from_slice(&serde_json::to_vec(&db).unwrap()).unwrap();
    let first = item(&db, &a).unwrap();
    assert_eq!(first["acceptedVersion"], 1);
    assert_eq!(first["input"]["ticket"], "A");
    assert_eq!(file(first, 1, "report.txt").unwrap(), "A 最终报告");
    let second = item_mut(&mut db, &b).unwrap();
    assert_eq!(second["input"]["ticket"], "B");
    assert_eq!(file(second, 1, "report.txt").unwrap(), "B 初稿");
    assert_eq!(file(second, 2, "report.txt").unwrap(), "B 含验证结果");
    assert_eq!(second["deliveries"][0]["review"]["comment"], "补充验证结果");
    review(second, 2, verdict("accept", "证据齐全")).unwrap();
    assert_eq!(second["acceptedVersion"], 2);
    assert_eq!(second["status"], "delivered");
    assert!(matches!(
        review(second, 2, verdict("reject", "迟到")),
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        deliver(second, report("C")),
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        file(second, 3, "report.txt"),
        Err(Error::NotFound(_))
    ));
}

#[test]
fn delivery_checks_state_attempts_and_files_before_appending() {
    let mut db = json!({});
    let id = new(&mut db, "T");
    let item = item_mut(&mut db, &id).unwrap();
    assert!(matches!(
        deliver(item, report("x")),
        Err(Error::Conflict(_))
    ));
    begin(item);
    assert!(matches!(
        start(item, body(json!({"assignee":"Someone Else"}))),
        Err(Error::Conflict(_))
    ));
    item["attempts"] = json!([{"id":"a","status":"running"}]);
    assert!(matches!(
        deliver(item, report("x")),
        Err(Error::Conflict(_))
    ));
    item["attempts"][0]["status"] = "succeeded".into();
    for bad in [
        json!({"files":{}}),
        json!({"files":{"../a":"text"}}),
        json!({"files":{"a":"  "}}),
        json!({"files":{"a":"text"},"attemptIds":["elsewhere"]}),
    ] {
        assert!(matches!(deliver(item, body(bad)), Err(Error::Invalid(_))));
    }
    assert_eq!(item["deliveries"], json!([]));
    assert_eq!(item["status"], "working");
    item["packageSnapshot"] = json!({"deliverables":["report.txt","evidence.txt"]});
    assert!(matches!(
        deliver(item, report("out")),
        Err(Error::Invalid(_))
    ));
    assert_eq!(item["deliveries"], json!([]));
    let submitted = deliver(
        item,
        body(json!({"files":{"report.txt":"out","evidence.txt":"evidence"},"attemptIds":["a"]})),
    )
    .unwrap();
    assert_eq!(submitted["deliveries"][0]["attemptIds"], json!(["a"]));
    assert!(matches!(
        deliver(item, report("overwrite")),
        Err(Error::Conflict(_))
    ));
}
