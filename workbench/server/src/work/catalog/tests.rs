use super::*;
use serde_json::json;

mod agent;

// These non-Agent definitions do not consult any package files.
fn publish(db: &mut Value, kind: &str, body: Value) -> Result<Value, Error> {
    super::publish(std::path::Path::new("."), db, kind, body)
}

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

#[test]
fn executor_config_schema_accepts_field_arrays_and_config_packages() {
    let mut db = json!({});
    let fields = json!([
        {"key":"title","label":"标题","type":"string","default":"报告"},
        {"key":"endpoint","label":"地址","type":"url","default":"https://api.example.test/v1"},
        {"key":"token","label":"令牌","type":"secret","default":{"ref":"secret://provider/token"}},
        {"key":"mode","label":"模式","type":"enum","options":[{"value":"fast","label":"快速"},{"value":"safe","label":"安全"}],"default":"safe"},
        {"key":"retries","label":"重试","type":"integer","min":0,"max":5,"default":2},
        {"key":"temperature","label":"温度","type":"number","min":0,"max":1,"default":0.2},
        {"key":"enabled","label":"启用","type":"boolean","default":true},
        {"key":"package","label":"配置包","type":"configPackage","default":"shared-config"}
    ]);
    let published = executor(
        &mut db,
        "assistant",
        json!({"configSchema": {"fields": fields}}),
    );
    assert_eq!(published["configSchema"]["fields"], fields);

    let bare = json!([{"key":"mode","label":"模式","type":"enum","options":[{"value":"safe","label":"安全"}]}]);
    assert_eq!(
        executor(&mut db, "bare", json!({"configSchema": bare.clone()}))["configSchema"],
        bare
    );
}

#[test]
fn executor_config_schema_rejects_unknown_fields_and_invalid_values() {
    let mut db = json!({});
    for schema in [
        json!([{"key":"title","label":"标题","type":"string","path":"/tmp"}]),
        json!([{"key":"title","label":"标题","type":"object"}]),
        json!([{"key":"mode","label":"模式","type":"enum","options":[]}]),
        json!([{"key":"mode","label":"模式","type":"enum","options":[{"value":"safe","label":"安全"}],"default":"fast"}]),
        json!([{"key":"count","label":"数量","type":"integer","min":3,"max":2}]),
        json!([{"key":"count","label":"数量","type":"integer","min":0,"default":2.5}]),
        json!([{"key":"package","label":"配置包","type":"configPackage","default":"../secret"}]),
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
fn secret_schema_accepts_only_redacted_or_internal_reference() {
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
                json!({"id":"bad","configSchema":[{"key":"token","label":"令牌","type":"secret","default":default}]})
            ),
            Err(Error::Invalid(_))
        ));
    }
    let safe = executor(
        &mut db,
        "safe",
        json!({"configSchema":[
            {"key":"token","label":"令牌","type":"secret","default":"***"},
            {"key":"managed","label":"托管","type":"secret","default":{"ref":"secret://vault/token"}}
        ]}),
    );
    assert_eq!(safe["configSchema"][0]["default"], "***");
}

#[test]
fn executor_references_fixed_resource_revisions() {
    let mut db = json!({});
    resource(&mut db, "guide", "skill", "v1".into());
    resource(&mut db, "guide", "skill", "v2".into());
    let deps = json!({"resources":[{"id":"guide","revision":1}]});
    let e = executor(&mut db, "assistant", deps.clone());
    assert_eq!(e["resources"], deps["resources"]);
    deactivate(&mut db, "resources", "guide").unwrap();
    assert!(matches!(
        publish(&mut db, "executors", e),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        publish(
            &mut db,
            "executors",
            json!({"id":"another","resources":deps["resources"]})
        ),
        Err(Error::Conflict(_))
    ));
    assert_eq!(
        version(&db, "resources", "guide", 1).unwrap()["content"],
        "v1"
    );
}

#[test]
fn mcp_rejects_inline_credentials() {
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
}
