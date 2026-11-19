use super::*;

#[test]
fn accepts_valid_spec_without_user_endpoints() {
    let spec: SandboxSpec = serde_json::from_value(serde_json::json!({
        "image": "example/image:tag",
        "command": ["agent"],
        "labels": {"team": "sandbox"},
        "memory_mb": 512,
        "cpus": 2.0,
        "bundle": {
            "url": "https://example.invalid/agent.tgz",
            "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "min_image_level": 1
        },
        "runtime_profile": "pi"
    }))
    .unwrap();
    spec.validate().unwrap();
}

#[test]
fn rejects_user_ports_as_unknown_input() {
    let result = serde_json::from_value::<SandboxSpec>(serde_json::json!({
        "image": "example/image:tag",
        "ports": [{"name": "ssh", "port": 2222, "visibility": "public"}]
    }));
    assert!(result.is_err());
}

#[test]
fn logical_endpoint_never_serializes_address() {
    let endpoint = Endpoint {
        name: "ssh".into(),
        bundle: "ssh".into(),
        protocol: "ssh".into(),
        port: 2222,
        state: EndpointState::Ready,
        ready: true,
    };
    let json = serde_json::to_value(endpoint).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "name": "ssh",
            "bundle": "ssh",
            "protocol": "ssh",
            "port": 2222,
            "state": "ready",
            "ready": true
        })
    );
    assert!(json.get("address").is_none());
}

#[test]
fn sandbox_endpoint_json_round_trips() {
    let sandbox = Sandbox {
        id: "sandbox-1".into(),
        spec: serde_json::from_value(serde_json::json!({"image": "example:tag"})).unwrap(),
        resource: Resource {
            generation: 1,
            data_generation: 1,
        },
        status: Status::Running,
        operation: None,
        retired: vec![],
        revision: 1,
        endpoints: vec![Endpoint {
            name: "agent".into(),
            bundle: "agent-session".into(),
            protocol: "tcp".into(),
            port: 9000,
            state: EndpointState::Declared,
            ready: false,
        }],
        error: None,
    };
    let restored: Sandbox =
        serde_json::from_value(serde_json::to_value(&sandbox).unwrap()).unwrap();
    assert_eq!(restored.endpoints, sandbox.endpoints);
}
