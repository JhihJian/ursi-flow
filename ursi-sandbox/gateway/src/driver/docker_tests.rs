use super::*;
use crate::models::{BundleRef, Endpoint, EndpointState, SandboxSpec, Status};
use serde_json::json;

fn sandbox() -> Sandbox {
    Sandbox {
        id: "test".into(),
        spec: SandboxSpec {
            image: "runtime:latest".into(),
            command: vec![],
            labels: BTreeMap::new(),
            memory_mb: 256,
            cpus: 1.5,
            bundle: None,
            runtime_profile: None,
        },
        resource: Resource {
            generation: 2,
            data_generation: 1,
        },
        status: Status::Preparing,
        operation: None,
        retired: vec![],
        revision: 1,
        endpoints: vec![],
        error: None,
    }
}

fn driver() -> DockerDriver {
    DockerDriver::new("unit".into()).unwrap()
}

fn object(driver: &DockerDriver, sandbox: &Sandbox, running: bool) -> Value {
    json!({"Id": "abcdef0123", "Config": {"Labels": driver.labels(&sandbox.id, sandbox.resource, false)},
        "State": {"Running": running}, "NetworkSettings": {"Networks": {"bridge": {"IPAddress": "172.18.0.4"}}}})
}

fn volume(driver: &DockerDriver, sandbox: &Sandbox) -> Value {
    json!({"Labels": driver.labels(&sandbox.id, sandbox.resource, true)})
}

fn output(value: Value) -> Result<CliOutput> {
    Ok(CliOutput {
        success: true,
        stdout: serde_json::to_vec(&vec![value]).unwrap(),
        stderr: vec![],
        truncated: false,
    })
}
fn success() -> Result<CliOutput> {
    Ok(CliOutput {
        success: true,
        stdout: vec![],
        stderr: vec![],
        truncated: false,
    })
}
fn absent(kind: &str, name: &str) -> Result<CliOutput> {
    Ok(CliOutput {
        success: false,
        stdout: b"[]".to_vec(),
        stderr: format!("Error response from daemon: No such {kind}: {name}\n").into_bytes(),
        truncated: false,
    })
}
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).into()).collect()
}
fn scripted(
    mut driver: DockerDriver,
    steps: Vec<(Vec<String>, Result<CliOutput>)>,
) -> DockerDriver {
    driver.script = Some(std::sync::Mutex::new(steps.into()));
    driver
}
fn drained(driver: &DockerDriver) {
    assert!(driver.script.as_ref().unwrap().lock().unwrap().is_empty());
}

#[test]
fn configuration_names_and_volume_identity_are_strict() {
    for namespace in ["", "../host", "-option", "name with spaces"] {
        assert!(DockerDriver::new(namespace.into()).is_err());
    }
    let driver = driver();
    let sandbox = sandbox();
    assert_eq!(
        driver.names(&sandbox.id, sandbox.resource).unwrap(),
        ("unit-test-r2".into(), "unit-test-v1".into())
    );
    assert_eq!(
        driver.labels(&sandbox.id, sandbox.resource, true)[GENERATION],
        "1"
    );
    let mut foreign = volume(&driver, &sandbox);
    for key in [SCOPE, ID, GENERATION, DATA_GENERATION] {
        foreign["Labels"][key] = json!("foreign");
        assert!(matches!(
            driver.owned(&foreign, &sandbox.id, sandbox.resource, true),
            Err(Error::Conflict(_))
        ));
        foreign = volume(&driver, &sandbox);
    }
}

#[test]
fn create_flags_enforce_resources_security_and_visibility_without_shell() {
    let driver = driver();
    let mut sandbox = sandbox();
    sandbox.spec.labels.insert(SCOPE.into(), "foreign".into());
    sandbox.spec.bundle = Some(BundleRef {
        url: "https://runtime.example/bundle?x=$HOME".into(),
        sha256: "a".repeat(64),
        min_image_level: 3,
    });
    let arguments = driver
        .create_args(&sandbox, "sha256:trusted".into())
        .unwrap();
    for pair in [
        args(&["--memory", "256m"]),
        args(&["--cpus", "1.5"]),
        args(&["--pids-limit", "256"]),
        args(&["--cap-drop", "ALL"]),
        args(&["--security-opt", "no-new-privileges"]),
        args(&[
            "--mount",
            "type=volume,src=unit-test-v1,dst=/ursi/workspace",
        ]),
    ] {
        assert!(arguments.windows(2).any(|window| window == pair));
    }
    assert!(!arguments.iter().any(|arg| arg == "--publish"));
    assert!(arguments.contains(&"io.ursi.scope=unit".into()));
    assert!(arguments.contains(&"io.ursi.user.io.ursi.scope=foreign".into()));
    assert!(arguments.contains(&"URSI_BUNDLE_URL=https://runtime.example/bundle?x=$HOME".into()));
    assert!(arguments.contains(&format!("URSI_BUNDLE_SHA256={}", "a".repeat(64))));
    assert!(arguments.contains(&"URSI_BUNDLE_MIN_IMAGE_LEVEL=3".into()));
    assert_eq!(arguments.last().unwrap(), "sha256:trusted");
    assert!(
        !arguments
            .iter()
            .any(|a| a == "--privileged" || a.contains("docker.sock") || a.contains("type=bind"))
    );
    sandbox.spec.command = vec!["echo".into(), "$(touch /host); spaces".into()];
    let arguments = driver.create_args(&sandbox, "image".into()).unwrap();
    assert_eq!(
        &arguments[arguments.len() - 2..],
        sandbox.spec.command.as_slice()
    );
}

#[test]
fn observed_uses_actual_running_health_and_distinct_network_addresses() {
    let driver = driver();
    let mut sandbox = sandbox();
    sandbox.endpoints = vec![
        Endpoint {
            name: "web".into(),
            bundle: "web".into(),
            protocol: "http".into(),
            port: 8080,
            state: EndpointState::Declared,
            ready: false,
        },
        Endpoint {
            name: "cdp".into(),
            bundle: "browser".into(),
            protocol: "tcp".into(),
            port: 9222,
            state: EndpointState::Declared,
            ready: true,
        },
    ];
    let mut object = object(&driver, &sandbox, true);
    object["State"]["Health"] = json!({"Status": "starting"});
    let observed = driver.observed(&sandbox, &object).unwrap();
    assert!(observed.running);
    assert_eq!(observed.healthy, Some(false));
    assert_eq!(observed.endpoints[0].address, "172.18.0.4:8080");
    assert_eq!(observed.endpoints[1].address, "172.18.0.4:9222");
    object["State"]["Health"]["Status"] = json!("healthy");
    assert_eq!(
        driver.observed(&sandbox, &object).unwrap().healthy,
        Some(true)
    );
    object["State"]["Running"] = json!(false);
    assert!(
        driver
            .observed(&sandbox, &object)
            .unwrap()
            .endpoints
            .is_empty()
    );
    assert_eq!(host("2001:db8::1"), "[2001:db8::1]");
}

#[tokio::test]
async fn existing_container_and_volume_are_reattached_without_creation() {
    let driver = driver();
    let sandbox = sandbox();
    let stopped = object(&driver, &sandbox, false);
    let running = object(&driver, &sandbox, true);
    let volume = volume(&driver, &sandbox);
    let driver = scripted(
        driver,
        vec![
            (
                args(&["container", "inspect", "unit-test-r2"]),
                output(stopped.clone()),
            ),
            (args(&["volume", "inspect", "unit-test-v1"]), output(volume)),
            (
                args(&["container", "inspect", "unit-test-r2"]),
                output(stopped),
            ),
            (args(&["start", "abcdef0123"]), success()),
            (
                args(&["container", "inspect", "unit-test-r2"]),
                output(running),
            ),
        ],
    );
    assert!(driver.ensure(&sandbox).await.unwrap().running);
    drained(&driver);
}

#[tokio::test]
async fn interrupted_container_creation_recovers_using_existing_volume() {
    let driver = driver();
    let sandbox = sandbox();
    let running = object(&driver, &sandbox, true);
    let volume = volume(&driver, &sandbox);
    let image_id = format!("sha256:{}", "f".repeat(64));
    let create = driver.create_args(&sandbox, image_id.clone()).unwrap();
    let driver = scripted(
        driver,
        vec![
            (
                args(&["container", "inspect", "unit-test-r2"]),
                absent("container", "unit-test-r2"),
            ),
            (
                args(&["image", "inspect", "runtime:latest"]),
                output(json!({"Id": image_id})),
            ),
            (args(&["volume", "inspect", "unit-test-v1"]), output(volume)),
            (create, Err(Error::Unavailable("response lost".into()))),
            (
                args(&["container", "inspect", "unit-test-r2"]),
                output(running.clone()),
            ),
            (
                args(&["container", "inspect", "unit-test-r2"]),
                output(running.clone()),
            ),
            (
                args(&["container", "inspect", "unit-test-r2"]),
                output(running),
            ),
        ],
    );
    assert!(driver.ensure(&sandbox).await.unwrap().running);
    drained(&driver);
}

#[tokio::test]
async fn first_create_pulls_image_creates_owned_volume_and_starts_container() {
    let driver = driver();
    let mut sandbox = sandbox();
    sandbox.resource.generation = 1;
    let stopped = object(&driver, &sandbox, false);
    let running = object(&driver, &sandbox, true);
    let volume = volume(&driver, &sandbox);
    let image_id = format!("sha256:{}", "f".repeat(64));
    let create_container = driver.create_args(&sandbox, image_id.clone()).unwrap();
    let mut create_volume = args(&["volume", "create"]);
    for (key, value) in driver.labels(&sandbox.id, sandbox.resource, true) {
        create_volume.extend(["--label".into(), format!("{key}={value}")]);
    }
    create_volume.push("unit-test-v1".into());
    let driver = scripted(
        driver,
        vec![
            (
                args(&["container", "inspect", "unit-test-r1"]),
                absent("container", "unit-test-r1"),
            ),
            (
                args(&["image", "inspect", "runtime:latest"]),
                absent("image", "runtime:latest"),
            ),
            (args(&["pull", "runtime:latest"]), success()),
            (
                args(&["image", "inspect", "runtime:latest"]),
                output(json!({"Id": image_id})),
            ),
            (
                args(&["volume", "inspect", "unit-test-v1"]),
                absent("volume", "unit-test-v1"),
            ),
            (create_volume, success()),
            (args(&["volume", "inspect", "unit-test-v1"]), output(volume)),
            (create_container, success()),
            (
                args(&["container", "inspect", "unit-test-r1"]),
                output(stopped),
            ),
            (args(&["start", "abcdef0123"]), success()),
            (
                args(&["container", "inspect", "unit-test-r1"]),
                output(running),
            ),
        ],
    );
    assert!(driver.ensure(&sandbox).await.unwrap().running);
    drained(&driver);
    assert!(missing(
        b"Error response from daemon: No such image: alpine:latest",
        "image",
        "alpine"
    ));
    assert!(missing(
        b"Error response from daemon: get unit-test-v1: no such volume",
        "volume",
        "unit-test-v1"
    ));
}

#[tokio::test]
async fn volume_create_is_verified_and_retry_recovers_lost_response() {
    let driver = driver();
    let mut sandbox = sandbox();
    sandbox.resource.generation = 1;
    let volume = volume(&driver, &sandbox);
    let mut create = args(&["volume", "create"]);
    for (key, value) in driver.labels(&sandbox.id, sandbox.resource, true) {
        create.extend(["--label".into(), format!("{key}={value}")]);
    }
    create.push("unit-test-v1".into());
    let driver = scripted(
        driver,
        vec![
            (
                args(&["volume", "inspect", "unit-test-v1"]),
                absent("volume", "unit-test-v1"),
            ),
            (create, Err(Error::Unavailable("response lost".into()))),
            (args(&["volume", "inspect", "unit-test-v1"]), output(volume)),
        ],
    );
    assert!(matches!(
        driver.volume(&sandbox).await,
        Err(Error::Unavailable(_))
    ));
    driver.volume(&sandbox).await.unwrap();
    drained(&driver);
}

#[tokio::test]
async fn bundle_image_level_is_checked_before_creating_resources() {
    for level in [None, Some("invalid"), Some("2"), Some("3"), Some("4")] {
        let driver = driver();
        let mut sandbox = sandbox();
        sandbox.spec.bundle = Some(BundleRef {
            url: "https://example.com/bundle".into(),
            sha256: "a".repeat(64),
            min_image_level: 3,
        });
        let driver = scripted(
            driver,
            vec![(
                args(&["image", "inspect", "runtime:latest"]),
                output(
                    json!({"Id": format!("sha256:{}", "a".repeat(64)), "Config": {"Labels": {"io.ursi.image-level": level}}}),
                ),
            )],
        );
        let result = driver.image(&sandbox).await;
        if level == Some("3") || level == Some("4") {
            assert!(result.is_ok());
        } else {
            assert!(matches!(result, Err(Error::Unsupported(_))));
        }
        drained(&driver);
    }
}

#[tokio::test]
async fn foreign_ownership_is_never_started_or_removed() {
    for key in [SCOPE, ID, GENERATION, DATA_GENERATION] {
        let driver = driver();
        let sandbox = sandbox();
        let mut foreign = object(&driver, &sandbox, false);
        foreign["Config"]["Labels"][key] = json!("foreign");
        let driver = scripted(
            driver,
            vec![(
                args(&["container", "inspect", "unit-test-r2"]),
                output(foreign),
            )],
        );
        assert!(matches!(
            driver.remove(&sandbox.id, sandbox.resource, true).await,
            Err(Error::Conflict(_))
        ));
        drained(&driver);
    }
    let driver = driver();
    let sandbox = sandbox();
    let container = object(&driver, &sandbox, false);
    let mut foreign = volume(&driver, &sandbox);
    foreign["Labels"][SCOPE] = json!("foreign");
    let driver = scripted(
        driver,
        vec![
            (
                args(&["container", "inspect", "unit-test-r2"]),
                output(container),
            ),
            (
                args(&["volume", "inspect", "unit-test-v1"]),
                output(foreign),
            ),
        ],
    );
    assert!(matches!(
        driver.remove(&sandbox.id, sandbox.resource, true).await,
        Err(Error::Conflict(_))
    ));
    drained(&driver);
}

#[tokio::test]
async fn remove_is_idempotent_but_does_not_hide_query_errors() {
    let sandbox = sandbox();
    let driver = scripted(
        driver(),
        vec![
            (
                args(&["container", "inspect", "unit-test-r2"]),
                absent("container", "unit-test-r2"),
            ),
            (
                args(&["volume", "inspect", "unit-test-v1"]),
                absent("volume", "unit-test-v1"),
            ),
            (
                args(&["container", "inspect", "unit-test-r2"]),
                Err(Error::Unavailable("timeout".into())),
            ),
            (
                args(&["container", "inspect", "unit-test-r2"]),
                Ok(CliOutput {
                    success: false,
                    stdout: vec![],
                    stderr: b"Cannot connect to the Docker daemon".to_vec(),
                    truncated: false,
                }),
            ),
        ],
    );
    driver
        .remove(&sandbox.id, sandbox.resource, true)
        .await
        .unwrap();
    for _ in 0..2 {
        assert!(matches!(
            driver.remove(&sandbox.id, sandbox.resource, true).await,
            Err(Error::Unavailable(_))
        ));
    }
    drained(&driver);
    assert!(!missing(
        b"No such container: unit-test-r2\nCannot connect to daemon",
        "container",
        "unit-test-r2"
    ));
    assert!(!missing(
        b"No such container: another",
        "container",
        "unit-test-r2"
    ));
}

#[tokio::test]
async fn remove_uses_verified_container_id_and_only_selected_volume() {
    let driver = driver();
    let sandbox = sandbox();
    let container = object(&driver, &sandbox, false);
    let volume = volume(&driver, &sandbox);
    let driver = scripted(
        driver,
        vec![
            (
                args(&["container", "inspect", "unit-test-r2"]),
                output(container),
            ),
            (args(&["volume", "inspect", "unit-test-v1"]), output(volume)),
            (args(&["rm", "--force", "abcdef0123"]), success()),
            (args(&["volume", "rm", "unit-test-v1"]), success()),
        ],
    );
    driver
        .remove(&sandbox.id, sandbox.resource, true)
        .await
        .unwrap();
    drained(&driver);
}

#[tokio::test]
async fn preserve_data_remove_never_queries_or_deletes_the_volume() {
    let driver = driver();
    let sandbox = sandbox();
    let container = object(&driver, &sandbox, false);
    let driver = scripted(
        driver,
        vec![
            (
                args(&["container", "inspect", "unit-test-r2"]),
                output(container),
            ),
            (args(&["rm", "--force", "abcdef0123"]), success()),
        ],
    );
    driver
        .remove(&sandbox.id, sandbox.resource, false)
        .await
        .unwrap();
    drained(&driver);
}

#[tokio::test]
async fn logs_are_tail_capped_and_missing_is_distinct_from_failed_query() {
    let driver = driver();
    let sandbox = sandbox();
    let object = object(&driver, &sandbox, true);
    let driver = scripted(
        driver,
        vec![
            (
                args(&["container", "inspect", "unit-test-r2"]),
                output(object),
            ),
            (
                args(&["logs", "--tail", "5000", "abcdef0123"]),
                Ok(CliOutput {
                    success: true,
                    stdout: b"stdout\n".to_vec(),
                    stderr: b"stderr\n".to_vec(),
                    truncated: true,
                }),
            ),
            (
                args(&["container", "inspect", "unit-test-r2"]),
                absent("container", "unit-test-r2"),
            ),
            (
                args(&["container", "inspect", "unit-test-r2"]),
                Err(Error::Unavailable("timeout".into())),
            ),
        ],
    );
    let logs = driver.logs(&sandbox, usize::MAX).await.unwrap();
    assert!(logs.contains("stdout\nstderr\n"));
    assert!(logs.contains("日志输出已截断"));
    assert!(matches!(
        driver.observe(&sandbox).await,
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        driver.observe(&sandbox).await,
        Err(Error::Unavailable(_))
    ));
    drained(&driver);
}

#[test]
fn docker_29_missing_volume_requires_exact_name_and_complete_error() {
    let name = "unit-test-v1";
    for text in [
        "Error response from daemon: volume unit-test-v1 not found\n",
        "Error: volume unit-test-v1 not found",
        "volume unit-test-v1 not found",
    ] {
        assert!(missing(text.as_bytes(), "volume", name), "{text}");
        assert!(!missing(text.as_bytes(), "container", name));
    }
    for text in [
        "Error response from daemon: volume unit-test-v10 not found",
        "Error response from daemon: volume UNIT-test-v1 not found",
        "Error response from daemon: volume other not found",
        "Error response from daemon: No such volume: UNIT-test-v1",
        "Error response from daemon: volume unit-test-v1 not found\nCannot connect to daemon",
        "Cannot connect to daemon\nError response from daemon: volume unit-test-v1 not found",
        "Error response from daemon: volume unit-test-v1 not found: permission denied",
    ] {
        assert!(!missing(text.as_bytes(), "volume", name), "{text}");
    }
}

#[tokio::test]
async fn volume_inspect_accepts_docker_29_absence_but_not_mixed_or_truncated_errors() {
    for (stderr, truncated, absent) in [
        (
            "Error response from daemon: volume unit-test-v1 not found\n",
            false,
            true,
        ),
        (
            "Error response from daemon: volume unit-test-v1 not found\nCannot connect to daemon",
            false,
            false,
        ),
        (
            "Error response from daemon: volume unit-test-v1 not found",
            true,
            false,
        ),
    ] {
        let driver = scripted(
            driver(),
            vec![(
                args(&["volume", "inspect", "unit-test-v1"]),
                Ok(CliOutput {
                    success: false,
                    stdout: b"[]".to_vec(),
                    stderr: stderr.as_bytes().to_vec(),
                    truncated,
                }),
            )],
        );
        let result = driver.inspect("volume", "unit-test-v1").await;
        if absent {
            assert!(result.unwrap().is_none());
        } else {
            assert!(matches!(result, Err(Error::Unavailable(_))));
        }
        drained(&driver);
    }
}

#[tokio::test]
async fn preserve_rebuild_missing_volume_fails_without_creating_empty_data() {
    let sandbox = sandbox(); // generation 2, data_generation 1
    let driver = scripted(
        driver(),
        vec![
            (
                args(&["container", "inspect", "unit-test-r2"]),
                absent("container", "unit-test-r2"),
            ),
            (
                args(&["image", "inspect", "runtime:latest"]),
                output(json!({"Id": format!("sha256:{}", "a".repeat(64))})),
            ),
            (
                args(&["volume", "inspect", "unit-test-v1"]),
                absent("volume", "unit-test-v1"),
            ),
        ],
    );
    assert!(matches!(
        driver.ensure(&sandbox).await,
        Err(Error::Conflict(_))
    ));
    drained(&driver);
}

#[tokio::test]
async fn image_volumes_are_checked_before_creation_with_and_without_bundle() {
    for bundle in [false, true] {
        for declarations in [
            json!({"/extra": {}}),
            json!({"/ursi/workspace": {}, "/extra": {}}),
        ] {
            let mut sandbox = sandbox();
            sandbox.resource.generation = 1;
            if bundle {
                sandbox.spec.bundle = Some(BundleRef {
                    url: "https://example.com/bundle".into(),
                    sha256: "a".repeat(64),
                    min_image_level: 3,
                });
            }
            let driver = scripted(
                driver(),
                vec![
                    (
                        args(&["container", "inspect", "unit-test-r1"]),
                        absent("container", "unit-test-r1"),
                    ),
                    (
                        args(&["image", "inspect", "runtime:latest"]),
                        output(json!({
                            "Id": format!("sha256:{}", "a".repeat(64)),
                            "Config": {"Volumes": declarations, "Labels": {"io.ursi.image-level": "3"}}
                        })),
                    ),
                ],
            );
            assert!(matches!(
                driver.ensure(&sandbox).await,
                Err(Error::Unsupported(_))
            ));
            drained(&driver);
        }
    }
    for declarations in [Value::Null, json!({}), json!({"/ursi/workspace": {}})] {
        let driver = scripted(
            driver(),
            vec![(
                args(&["image", "inspect", "runtime:latest"]),
                output(
                    json!({"Id": format!("sha256:{}", "a".repeat(64)), "Config": {"Volumes": declarations}}),
                ),
            )],
        );
        assert!(driver.image(&sandbox()).await.is_ok());
        drained(&driver);
    }
}

fn daemon_info(id: Value) -> Result<CliOutput> {
    Ok(CliOutput {
        success: true,
        stdout: serde_json::to_vec(&id).unwrap(),
        stderr: vec![],
        truncated: false,
    })
}

#[tokio::test]
async fn connection_resolves_current_context_and_freezes_endpoint_and_daemon_identity() {
    let mut driver = scripted(
        driver(),
        vec![
            (
                args(&["context", "inspect"]),
                output(json!({"Endpoints": {"docker": {"Host": "unix:///run/docker.sock"}}})),
            ),
            (
                args(&["info", "--format", "{{json .ID}}"]),
                daemon_info(json!("daemon-123")),
            ),
        ],
    );
    driver.initialize_connection(None, None).await.unwrap();
    assert_eq!(
        driver.docker_host.as_deref(),
        Some("unix:///run/docker.sock")
    );
    let identity: (String, String) = serde_json::from_str(driver.identity()).unwrap();
    assert_eq!(
        identity,
        ("unix:///run/docker.sock".into(), "daemon-123".into())
    );
    drained(&driver);
}

#[tokio::test]
async fn explicit_context_overrides_host_and_explicit_host_bypasses_default_context() {
    let mut context_driver = scripted(
        driver(),
        vec![
            (
                args(&["context", "inspect", "--", "selected"]),
                output(json!({"Endpoints": {"docker": {"Host": "unix:///run/selected.sock"}}})),
            ),
            (
                args(&["info", "--format", "{{json .ID}}"]),
                daemon_info(json!("selected-daemon")),
            ),
        ],
    );
    context_driver
        .initialize_connection(Some("selected".into()), Some("tcp://ignored:2376".into()))
        .await
        .unwrap();
    assert_eq!(
        context_driver.docker_host.as_deref(),
        Some("unix:///run/selected.sock")
    );
    drained(&context_driver);

    let mut host_driver = scripted(
        driver(),
        vec![(
            args(&["info", "--format", "{{json .ID}}"]),
            daemon_info(json!("host-daemon")),
        )],
    );
    host_driver
        .initialize_connection(None, Some("unix:///run/host.sock".into()))
        .await
        .unwrap();
    assert_eq!(
        host_driver.docker_host.as_deref(),
        Some("unix:///run/host.sock")
    );
    assert_ne!(host_driver.identity(), context_driver.identity());
    drained(&host_driver);
}

#[tokio::test]
async fn connection_rejects_remote_targets_missing_context_endpoint_and_invalid_daemon_id() {
    for endpoint in [
        "tcp://localhost:2375",
        "ssh://host",
        "npipe:////./pipe/docker_engine",
        "unix://relative",
        "unix:///",
        "unix:///run/docker.sock\n",
    ] {
        let mut driver = scripted(driver(), vec![]);
        assert!(matches!(
            driver
                .initialize_connection(None, Some(endpoint.into()))
                .await,
            Err(Error::Unsupported(_))
        ));
        drained(&driver);
    }
    let mut context_driver = scripted(
        driver(),
        vec![(
            args(&["context", "inspect"]),
            output(json!({"Endpoints": {}})),
        )],
    );
    assert!(matches!(
        context_driver.initialize_connection(None, None).await,
        Err(Error::Unavailable(_))
    ));
    drained(&context_driver);
    for id in [
        json!(""),
        json!("a\nb"),
        Value::Null,
        json!({"ID": "unexpected"}),
    ] {
        let mut driver = scripted(
            driver(),
            vec![(args(&["info", "--format", "{{json .ID}}"]), daemon_info(id))],
        );
        assert!(matches!(
            driver
                .initialize_connection(None, Some("unix:///run/docker.sock".into()))
                .await,
            Err(Error::Unavailable(_))
        ));
        assert!(driver.identity().is_empty());
        drained(&driver);
    }
}

#[tokio::test]
async fn every_cli_command_pins_target_without_inheriting_mutable_context_or_tls() {
    let mut driver = scripted(
        driver(),
        vec![(
            args(&["info", "--format", "{{json .ID}}"]),
            daemon_info(json!("daemon-123")),
        )],
    );
    driver
        .initialize_connection(None, Some("unix:///run/frozen.sock".into()))
        .await
        .unwrap();
    let identity = driver.identity().to_owned();
    for arguments in [
        args(&["info", "--format", "{{json .ID}}"]),
        args(&["image", "inspect", "runtime:latest"]),
        args(&["pull", "runtime:latest"]),
        args(&["volume", "create", "unit-test-v1"]),
        args(&["create", "--name", "unit-test-r2", "runtime:latest"]),
        args(&["start", "abcdef0123"]),
        args(&["stop", "--time", "10", "abcdef0123"]),
        args(&["rm", "--force", "abcdef0123"]),
        args(&["volume", "rm", "unit-test-v1"]),
        args(&["logs", "--tail", "10", "abcdef0123"]),
    ] {
        let command = driver.command(arguments.clone());
        let command = command.as_std();
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            arguments
                .iter()
                .map(std::ffi::OsStr::new)
                .collect::<Vec<_>>()
        );
        let env: BTreeMap<_, _> = command.get_envs().collect();
        assert_eq!(
            env.get(std::ffi::OsStr::new("DOCKER_HOST")),
            Some(&Some(std::ffi::OsStr::new("unix:///run/frozen.sock")))
        );
        for removed in [
            "DOCKER_CONTEXT",
            "DOCKER_TLS",
            "DOCKER_TLS_VERIFY",
            "DOCKER_CERT_PATH",
        ] {
            assert_eq!(env.get(std::ffi::OsStr::new(removed)), Some(&None));
        }
        assert_eq!(driver.identity(), identity);
    }
    drained(&driver);
}

#[tokio::test]
async fn bounded_reader_drains_all_input_without_retaining_excess() {
    let input = vec![b'x'; 1024 * 1024];
    let (bytes, truncated) = read_bounded(input.as_slice(), 512).await.unwrap();
    assert_eq!(bytes.len(), 512);
    assert!(truncated);
}

#[cfg(unix)]
#[tokio::test]
async fn real_process_timeout_is_unavailable_without_calling_docker() {
    let mut command = Command::new("sleep");
    command.arg("5");
    let begin = std::time::Instant::now();
    assert!(matches!(
        execute(command, Duration::from_millis(20), 256).await,
        Err(Error::Unavailable(_))
    ));
    assert!(begin.elapsed() < Duration::from_secs(2));
}
