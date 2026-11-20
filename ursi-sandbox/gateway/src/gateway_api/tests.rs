use super::*;

#[test]
fn bearer_auth_rejects_missing_wrong_duplicate_and_query_style_credentials() {
    let mut headers = HeaderMap::new();
    assert!(!authorized(&headers, "secret"));
    for value in [
        "Basic secret",
        "Bearer wrong",
        "Bearer secret ",
        "Bearer  secret",
        "Bearer",
        "Bearer ",
    ] {
        headers.insert(header::AUTHORIZATION, value.parse().unwrap());
        assert!(!authorized(&headers, "secret"), "accepted {value}");
    }
    headers.insert(header::AUTHORIZATION, "bEaReR secret".parse().unwrap());
    assert!(authorized(&headers, "secret"));
    headers.append(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
    assert!(!authorized(&headers, "secret"));
}

#[test]
fn tunnel_rejects_origin_queries_and_wrong_protocol() {
    let uri: Uri = "/api/v1/sandboxes/test/connect/session".parse().unwrap();
    let mut headers = HeaderMap::new();
    assert!(validate_connect(&uri, &headers).is_err());
    headers.insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        "grasp-tcp-v1".parse().unwrap(),
    );
    assert!(validate_connect(&uri, &headers).is_err());
    headers.insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        "other, ursi-tcp-v1".parse().unwrap(),
    );
    assert!(validate_connect(&uri, &headers).is_ok());
    headers.insert(header::ORIGIN, "".parse().unwrap());
    assert!(validate_connect(&uri, &headers).is_err());
    headers.remove(header::ORIGIN);
    for suffix in [
        "?",
        "?host=127.0.0.1",
        "?url=http://internal",
        "?token=secret",
    ] {
        let uri = format!("/api/v1/sandboxes/test/connect/session{suffix}")
            .parse()
            .unwrap();
        assert!(validate_connect(&uri, &headers).is_err());
    }
}

#[cfg(feature = "driver-fake")]
#[tokio::test]
async fn create_validates_profile_after_binding_admin_runtime() {
    use crate::{driver::fake::FakeDriver, lifecycle::store::Store};

    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("gateway.sqlite")).unwrap());
    let registry =
        Registry::from_json(include_str!("../../../gateway-registry.example.json")).unwrap();
    let service =
        Service::with_registry(store, Arc::new(FakeDriver::new()), Arc::new(registry), None);
    let state = ApiState {
        service,
        api_key: "test-key".into(),
        tunnel_enabled: true,
    };
    let spec = |image| {
        serde_json::from_value(json!({"image": image, "runtime_profile": "browser"})).unwrap()
    };
    let result = create(
        State(state.clone()),
        HeaderMap::new(),
        Ok(Json(spec("ursi-runtime-browser:local"))),
    )
    .await
    .unwrap_or_else(|error| panic!("expected 202, got {}", error.into_response().status()));
    assert_eq!(result.status(), StatusCode::ACCEPTED);
    let body = axum::body::to_bytes(result.into_body(), 8192)
        .await
        .unwrap();
    let row: Sandbox = serde_json::from_slice(&body).unwrap();
    assert_eq!(row.spec.runtime_profile.as_deref(), Some("browser"));
    assert!(row.spec.bundle.is_none());
    assert!(row.endpoints.iter().any(|e| e.name == "desktop"));
    assert!(!row.endpoints.iter().any(|e| e.name == "cdp"));

    let result = create(
        State(state),
        HeaderMap::new(),
        Ok(Json(spec("alpine:3.22"))),
    )
    .await;
    assert_eq!(
        result.err().unwrap().into_response().status(),
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn error_mapping_is_structured_and_never_leaks_driver_details() {
    let cases = [
        (
            Error::Invalid("secret driver detail".into()),
            400,
            "invalid",
        ),
        (
            Error::NotFound("secret driver detail".into()),
            404,
            "not_found",
        ),
        (
            Error::Conflict("secret driver detail".into()),
            409,
            "conflict",
        ),
        (
            Error::Unsupported("secret driver detail".into()),
            501,
            "unsupported",
        ),
        (
            Error::Unavailable("secret driver detail".into()),
            503,
            "unavailable",
        ),
        (
            Error::Internal("secret driver detail".into()),
            500,
            "internal",
        ),
    ];
    for (error, status, code) in cases {
        let response = ApiError::from(error).into_response();
        assert_eq!(response.status().as_u16(), status);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"]["code"], code);
        assert!(json["error"]["message"].is_string());
        assert!(!String::from_utf8_lossy(&bytes).contains("secret"));
    }
}

#[test]
fn rebuild_requires_an_explicit_boolean_and_logs_reject_bad_queries() {
    for body in [
        "{}",
        r#"{"preserve_data":null}"#,
        r#"{"preserve_data":"true"}"#,
        r#"{"preserve_data":true,"host":"localhost"}"#,
    ] {
        assert!(serde_json::from_str::<Rebuild>(body).is_err());
    }
    assert!(
        serde_json::from_str::<Rebuild>(r#"{"preserve_data":true}"#)
            .unwrap()
            .preserve_data
    );
    assert!(
        !serde_json::from_str::<Rebuild>(r#"{"preserve_data":false}"#)
            .unwrap()
            .preserve_data
    );
    assert_eq!(
        Query::<LogsQuery>::try_from_uri(&"/logs".parse().unwrap())
            .unwrap()
            .tail,
        5000
    );
    for uri in [
        "/logs?tail=-1",
        "/logs?tail=no",
        "/logs?host=localhost",
        "/logs?tail=1&tail=2",
    ] {
        assert!(Query::<LogsQuery>::try_from_uri(&uri.parse().unwrap()).is_err());
    }
}
