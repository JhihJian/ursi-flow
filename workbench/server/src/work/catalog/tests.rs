use super::*;
use serde_json::json;

fn resource(db: &mut Value, id: &str, kind: &str, content: Value) -> Value {
    publish(
        db,
        "resources",
        json!({"id":id,"kind":kind,"content":content}),
    )
    .unwrap()
}

fn agent(db: &mut Value, id: &str, resources: Value) -> Value {
    publish(
        db,
        "executors",
        json!({"id":id,"kind":"agent","resources":resources}),
    )
    .unwrap()
}

fn package(db: &mut Value, id: &str, executor: Value, resources: Value) -> Value {
    publish(
        db,
        "packages",
        json!({
            "id":id,
            "sop":"按步骤处理",
            "acceptance":"结果可核查",
            "actions":{"analyze":{"executor":executor,"resources":resources}}
        }),
    )
    .unwrap()
}

#[test]
fn publication_freezes_versions_and_resolves_dependencies() {
    let mut db = json!({});
    let first = resource(&mut db, "prompt", "prompt", "初版提示".into());
    let exec = agent(
        &mut db,
        "assistant",
        json!([{"id":"prompt","revision":first["revision"]}]),
    );
    let published = package(
        &mut db,
        "triage",
        json!({"id":"assistant","revision":exec["revision"]}),
        json!([]),
    );
    assert_eq!(
        resolve(&db, "triage", 1, true).unwrap(),
        json!({
            "id":"triage",
            "revision":1,
            "sop":"按步骤处理",
            "acceptance":"结果可核查",
            "actions":{"analyze":{
                "executor":{"id":"assistant","revision":1,"kind":"agent"},
                "resources":[{"id":"prompt","revision":1,"kind":"prompt","content":"初版提示"}]
            }}
        })
    );
    assert_eq!(published["revision"], 1);

    resource(&mut db, "prompt", "prompt", "新版提示".into());
    agent(&mut db, "assistant", json!([{"id":"prompt","revision":2}]));
    assert_eq!(
        resolve(&db, "triage", 1, true).unwrap()["sop"],
        "按步骤处理"
    );
    assert_eq!(
        resolve(&db, "triage", 1, true).unwrap()["actions"]["analyze"]["resources"][0]["content"],
        "初版提示"
    );
}

#[test]
fn deactivation_blocks_new_references_but_keeps_history_readable() {
    let mut db = json!({});
    resource(&mut db, "prompt", "prompt", "内容".into());
    let exec = agent(&mut db, "assistant", json!([{"id":"prompt","revision":1}]));
    package(
        &mut db,
        "triage",
        json!({"id":"assistant","revision":exec["revision"]}),
        json!([]),
    );
    deactivate(&mut db, "resources", "prompt").unwrap();
    assert!(matches!(
        publish(
            &mut db,
            "executors",
            json!({"id":"other","kind":"agent","resources":[{"id":"prompt","revision":1}]})
        ),
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        resolve(&db, "triage", 1, true),
        Err(Error::Conflict(_))
    ));
    assert_eq!(
        resolve(&db, "triage", 1, false).unwrap()["actions"]["analyze"]["resources"][0]["content"],
        "内容"
    );
    deactivate(&mut db, "packages", "triage").unwrap();
    assert!(matches!(
        resolve(&db, "triage", 1, true),
        Err(Error::Conflict(_))
    ));
    assert_eq!(resolve(&db, "triage", 1, false).unwrap()["revision"], 1);
}

#[test]
fn port_mismatch_and_conflicting_resource_revisions_leave_old_package_alone() {
    let mut db = json!({"other":"unchanged"});
    resource(&mut db, "guide", "skill", "v1".into());
    resource(&mut db, "guide", "skill", "v2".into());
    publish(&mut db,"executors",json!({"id":"agent","kind":"agent","resources":[{"id":"guide","revision":1}],"inputs":{"ticket":"string"},"outputs":{"report":"string"}})).unwrap();
    let b = json!({"id":"p","sop":"步骤","acceptance":"有报告","inputs":{"ticket":"string"},"outputs":{"report":"string"},"resources":[{"id":"guide","revision":1}],"actions":{"run":{"executor":{"id":"agent","revision":1}}}});
    let frozen = publish(&mut db, "packages", b.clone()).unwrap();
    assert_eq!(
        frozen["actions"]["run"]["resources"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    for (field, value) in [
        ("inputs", json!({"ticket":"integer"})),
        ("outputs", json!({"missing":"string"})),
        ("resources", json!([{"id":"guide","revision":2}])),
    ] {
        let mut bad = b.clone();
        bad[field] = value;
        let before = db.clone();
        assert!(publish(&mut db, "packages", bad).is_err());
        assert_eq!(db, before);
    }
    assert_eq!(publish(&mut db, "packages", b).unwrap()["revision"], 2);
    let mut db: Value = serde_json::from_str(&db.to_string()).unwrap();
    assert_eq!(list_latest(&db, "packages").unwrap()[0]["revision"], 2);
    deactivate(&mut db, "executors", "agent").unwrap();
    assert!(matches!(
        resolve(&db, "p", 1, true),
        Err(Error::Conflict(_))
    ));
    assert_eq!(resolve(&db, "p", 1, false).unwrap(), frozen);
    assert_eq!(db["other"], "unchanged");
}

#[test]
fn mcp_only_accepts_registered_names() {
    let mut db = json!({});
    let good = json!({"serverRef":"search","credentialRef":"auth-prod"});
    assert_eq!(
        resource(&mut db, "search", "mcp", good.clone())["content"],
        good
    );
    for bad in [
        json!({"serverRef":"search","headers":[{"Authorization":"hidden"}]}),
        json!({"serverRef":"https://name:pass@host"}),
        json!({"serverRef":"search","credentialRef":{"value":"hidden"}}),
    ] {
        assert!(matches!(
            publish(
                &mut db,
                "resources",
                json!({"id":"search","kind":"mcp","content":bad})
            ),
            Err(Error::Invalid(_))
        ));
    }
    assert_eq!(latest(&db, "resources", "search").unwrap()["revision"], 1);
}

#[test]
fn invalid_dependencies_and_plaintext_mcp_secrets_are_rejected_without_writes() {
    let mut db = json!({});
    assert!(matches!(
        publish(
            &mut db,
            "resources",
            json!({"id":"mcp","kind":"mcp","content":{"url":"https://mcp","token":"secret"}})
        ),
        Err(Error::Invalid(_))
    ));
    assert_eq!(db, json!({}));
    assert!(matches!(
        publish(
            &mut db,
            "executors",
            json!({"id":"agent","kind":"agent","program":"/tmp/user-command"})
        ),
        Err(Error::Invalid(_))
    ));
    resource(&mut db, "prompt", "prompt", "内容".into());
    assert!(matches!(
        publish(
            &mut db,
            "packages",
            json!({
                "id":"bad",
                "sop":"按步骤处理",
                "acceptance":"结果可核查",
                "actions":{"analyze":{"executor":{"id":"missing","revision":1},"resources":[]}}
            })
        ),
        Err(Error::NotFound(_))
    ));
    assert_eq!(list_latest(&db, "packages").unwrap(), json!([]));
}

#[test]
fn environment_is_frozen_and_only_an_agent_enum() {
    let mut db = json!({});
    for env in [json!(null), json!("/tmp"), json!({"cwd":"/"})] {
        assert!(
            publish(
                &mut db,
                "executors",
                json!({"id":"a","kind":"agent","environment":env})
            )
            .is_err()
        );
    }
    assert!(
        publish(
            &mut db,
            "executors",
            json!({"id":"f","kind":"flow","flowId":"f","flowRevision":"r","environment":"local"})
        )
        .is_err()
    );
    for env in ["sandbox", "local"] {
        let exec = publish(
            &mut db,
            "executors",
            json!({"id":"a","kind":"agent","environment":env}),
        )
        .unwrap();
        package(
            &mut db,
            "p",
            json!({"id":"a","revision":exec["revision"]}),
            json!([]),
        );
    }
    for (rev, env) in [(1, "sandbox"), (2, "local")] {
        assert_eq!(
            resolve(&db, "p", rev, true).unwrap()["actions"]["analyze"]["executor"]["environment"],
            env
        );
    }
}

#[test]
fn flow_requires_pinned_revision_and_cannot_receive_resources() {
    let mut db = json!({});
    resource(&mut db, "x", "skill", "步骤".into());
    for bad in [
        json!({"id":"missing-id","kind":"flow","flowRevision":"r"}),
        json!({"id":"missing-rev","kind":"flow","flowId":"verify"}),
    ] {
        assert!(matches!(
            publish(&mut db, "executors", bad),
            Err(Error::Invalid(_))
        ));
    }
    let flow = publish(
        &mut db,
        "executors",
        json!({"id":"flow","kind":"flow","flowId":"verify","flowRevision":"catalog-1"}),
    )
    .unwrap();
    let snapshot = package(
        &mut db,
        "flow-package",
        json!({"id":"flow","revision":flow["revision"]}),
        json!([]),
    );
    assert_eq!(
        snapshot["actions"]["analyze"]["executor"]["flowId"],
        "verify"
    );
    assert_eq!(
        snapshot["actions"]["analyze"]["executor"]["flowRevision"],
        "catalog-1"
    );
    assert_eq!(snapshot["actions"]["analyze"]["resources"], json!([]));
    assert!(matches!(
        publish(
            &mut db,
            "executors",
            json!({"id":"bad-flow","kind":"flow","flowId":"verify","flowRevision":"r","resources":[{"id":"x","revision":1}]})
        ),
        Err(Error::Invalid(_))
    ));
}
