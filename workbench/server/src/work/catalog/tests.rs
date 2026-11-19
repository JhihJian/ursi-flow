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

fn executor(db: &mut Value, id: &str, extra: Value) -> Value {
    let mut body = json!({"id":id});
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    publish(db, "executors", body).unwrap()
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
fn executor_config_schema_supports_all_restricted_types_and_defaults() {
    let mut db = json!({});
    let definition = json!({
        "configSchema": {
            "title": {"type":"string", "default":"报告"},
            "endpoint": {"type":"url", "default":"https://api.example.test/v1"},
            "token": {"type":"secret", "default":{"ref":"secret://provider/token"}},
            "mode": {"type":"enum", "values":["fast","safe"], "default":"safe"},
            "retries": {"type":"integer", "minimum":0, "maximum":5, "default":2},
            "temperature": {"type":"number", "minimum":0, "maximum":1, "default":0.2},
            "enabled": {"type":"boolean", "default":true}
        }
    });
    let published = executor(&mut db, "assistant", definition.clone());
    assert_eq!(published["id"], "assistant");
    assert_eq!(published["configSchema"], definition["configSchema"]);
    assert_eq!(
        latest(&db, "executors", "assistant").unwrap()["configSchema"],
        definition["configSchema"]
    );
}

#[test]
fn executor_config_schema_rejects_unknown_fields_and_arbitrary_json_schema() {
    let mut db = json!({});
    for schema in [
        json!({"title":{"type":"string","description":"free form"}}),
        json!({"title":{"type":"string","path":"/tmp"}}),
        json!({"title":{"type":"string","command":"echo"}}),
        json!({"title":{"type":"string","environment":{"TOKEN":"x"}}}),
        json!({"title":{"type":"string","kind":"agent"}}),
        json!({"endpoint":{"type":"url","default":"/tmp/service"}}),
        json!({"endpoint":{"type":"url","default":"https://"}}),
        json!({"type":"object","properties":{"title":{"type":"string"}}}),
        json!({"title":{"type":"object","properties":{}}}),
    ] {
        let before = db.clone();
        assert!(matches!(
            publish(
                &mut db,
                "executors",
                json!({"id":"bad","configSchema":schema})
            ),
            Err(Error::Invalid(_))
        ));
        assert_eq!(db, before);
    }
    for field in [
        "kind",
        "environment",
        "flowId",
        "flowRevision",
        "program",
        "command",
        "path",
        "env",
    ] {
        let before = db.clone();
        let mut body = json!({"id":"bad"});
        body[field] = json!("forbidden");
        assert!(matches!(
            publish(&mut db, "executors", body),
            Err(Error::Invalid(_))
        ));
        assert_eq!(db, before);
    }
}

#[test]
fn executor_config_schema_enforces_enum_and_numeric_bounds() {
    let mut db = json!({});
    for schema in [
        json!({"mode":{"type":"enum","values":[]}}),
        json!({"mode":{"type":"enum","values":["safe","safe"]}}),
        json!({"mode":{"type":"enum","values":["safe"],"default":"fast"}}),
        json!({"count":{"type":"integer","minimum":3,"maximum":2}}),
        json!({"count":{"type":"integer","minimum":0.5}}),
        json!({"count":{"type":"integer","minimum":0,"default":2.5}}),
        json!({"ratio":{"type":"number","minimum":0,"maximum":1,"default":2}}),
        json!({"enabled":{"type":"boolean","default":"yes"}}),
    ] {
        assert!(matches!(
            publish(
                &mut db,
                "executors",
                json!({"id":"bad","configSchema":schema})
            ),
            Err(Error::Invalid(_))
        ));
    }
    let good = executor(
        &mut db,
        "bounded",
        json!({"configSchema": {
            "count":{"type":"integer","minimum":0,"maximum":2,"default":0},
            "ratio":{"type":"number","minimum":0,"maximum":1,"default":1}
        }}),
    );
    assert_eq!(good["revision"], 1);
}

#[test]
fn secret_schema_accepts_only_redacted_or_internal_reference_and_never_echoes_plaintext() {
    let mut db = json!({});
    for default in [
        json!("plaintext-secret"),
        json!({"value":"plaintext-secret"}),
        json!({"ref":"plain-reference"}),
        json!({"ref":"/tmp/token"}),
        json!({"ref":"secret://"}),
    ] {
        assert!(matches!(
            publish(
                &mut db,
                "executors",
                json!({"id":"bad","configSchema":{"token":{"type":"secret","default":default}}})
            ),
            Err(Error::Invalid(_))
        ));
    }
    let redacted = executor(
        &mut db,
        "safe",
        json!({"configSchema": {
            "token":{"type":"secret","default":"***"},
            "other":{"type":"secret","default":{"redacted":true}},
            "managed":{"type":"secret","default":{"ref":"secret://vault/token"}}
        }}),
    );
    let text = redacted.to_string();
    assert!(!text.contains("plaintext-secret"));
    assert_eq!(redacted["configSchema"]["token"]["default"], "***");
    assert_eq!(
        latest(&db, "executors", "safe").unwrap()["configSchema"]["managed"]["default"]["ref"],
        "secret://vault/token"
    );
    assert!(
        !list_latest(&db, "executors")
            .unwrap()
            .to_string()
            .contains("plaintext-secret")
    );
}

#[test]
fn publication_freezes_generic_executor_and_resolves_dependencies() {
    let mut db = json!({});
    let first = resource(&mut db, "prompt", "prompt", "初版提示".into());
    let exec = executor(
        &mut db,
        "assistant",
        json!({"resources":[{"id":"prompt","revision":first["revision"]}]}),
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
                "executor":{"id":"assistant","revision":1},
                "resources":[{"id":"prompt","revision":1,"kind":"prompt","content":"初版提示"}]
            }}
        })
    );
    assert_eq!(published["revision"], 1);

    resource(&mut db, "prompt", "prompt", "新版提示".into());
    executor(
        &mut db,
        "assistant",
        json!({"resources":[{"id":"prompt","revision":2}]}),
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
    let exec = executor(
        &mut db,
        "assistant",
        json!({"resources":[{"id":"prompt","revision":1}]}),
    );
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
            json!({"id":"other","resources":[{"id":"prompt","revision":1}]})
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
}

#[test]
fn package_ports_are_independent_from_executor_and_conflicting_resource_revisions_leave_old_package_alone()
 {
    let mut db = json!({"other":"unchanged"});
    resource(&mut db, "guide", "skill", "v1".into());
    resource(&mut db, "guide", "skill", "v2".into());
    executor(
        &mut db,
        "generic",
        json!({"resources":[{"id":"guide","revision":1}]}),
    );
    let definition = json!({"id":"p","sop":"步骤","acceptance":"有报告","inputs":{"ticket":"string"},"outputs":{"report":"string"},"resources":[{"id":"guide","revision":1}],"actions":{"run":{"executor":{"id":"generic","revision":1}}}});
    let frozen = publish(&mut db, "packages", definition.clone()).unwrap();
    assert_eq!(
        frozen["actions"]["run"]["resources"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut conflicting = definition.clone();
    conflicting["resources"] = json!([{"id":"guide","revision":2}]);
    let before = db.clone();
    assert!(publish(&mut db, "packages", conflicting).is_err());
    assert_eq!(db, before);
    assert_eq!(
        publish(&mut db, "packages", definition).unwrap()["revision"],
        2
    );
    deactivate(&mut db, "executors", "generic").unwrap();
    assert!(matches!(
        resolve(&db, "p", 1, true),
        Err(Error::Conflict(_))
    ));
    assert_eq!(resolve(&db, "p", 1, false).unwrap(), frozen);
    assert_eq!(db["other"], "unchanged");
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
    resource(&mut db, "prompt", "prompt", "内容".into());
    assert!(matches!(
        publish(
            &mut db,
            "packages",
            json!({"id":"bad","sop":"按步骤处理","acceptance":"结果可核查","actions":{"analyze":{"executor":{"id":"missing","revision":1},"resources":[]}}})
        ),
        Err(Error::NotFound(_))
    ));
    assert_eq!(list_latest(&db, "packages").unwrap(), json!([]));
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
