//! Gateway v1 wire fixtures. No server DTOs or provider implementation imports.
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::{body::Bytes, http::Request};
use httptest::matchers::{all_of, contains, eq, json_decoded, matches, request};
use httptest::responders::{Responder, status_code};
use httptest::{Expectation, Server, ServerBuilder};
use serde_json::Value;

pub const KEY: &str = "consumer-test-gateway-key";
pub const ID: &str = "sb-provider-27";
pub const ENDPOINT: &str = "127.0.0.1:7000";
const COLLECTION: &str = "/api/v1/sandboxes";

pub fn example(name: &str) -> Value {
    let root = std::env::var_os("URSI_GATEWAY_V1_CONTRACT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../contracts/gateway/v1")
        });
    let path = root.join("examples").join(format!("{name}.json"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

pub fn spec() -> Value {
    example("create")
}

pub fn reply(code: u16, body: Value) -> impl Responder {
    status_code(code)
        .insert_header("content-type", "application/json")
        .body(body.to_string())
}

pub fn accepted() -> impl Responder {
    reply(202, example("accepted"))
}

pub fn running() -> impl Responder {
    reply(200, example("running"))
}

pub fn error(code: u16, kind: &str) -> impl Responder {
    reply(code, example(kind))
}

pub struct FakeGateway {
    server: Server,
    keys: Arc<Mutex<Vec<String>>>,
}

impl FakeGateway {
    pub fn new() -> Self {
        Self {
            server: ServerBuilder::new()
                .bind_addr(([0, 0, 0, 0], 0).into())
                .run()
                .unwrap(),
            keys: Default::default(),
        }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.server.addr().port())
    }

    pub fn keys(&self) -> Vec<String> {
        self.keys.lock().unwrap().clone()
    }

    pub fn post(&self, response: impl Responder + 'static) {
        let keys = Arc::clone(&self.keys);
        self.server.expect(
            Expectation::matching(all_of![
                request::method_path("POST", COLLECTION),
                request::headers(contains(("authorization", format!("Bearer {KEY}")))),
                request::headers(contains(("idempotency-key", matches(r"\S")))),
                request::body(json_decoded(eq(spec()))),
                move |req: &Request<Bytes>| {
                    let mut values = req.headers().get_all("idempotency-key").iter();
                    let Some(key) = values.next().and_then(|v| v.to_str().ok()) else {
                        return false;
                    };
                    if values.next().is_some() {
                        return false;
                    }
                    keys.lock().unwrap().push(key.to_owned());
                    true
                }
            ])
            .times(1)
            .respond_with(response),
        );
    }

    pub fn one(&self, method: &'static str, response: impl Responder + 'static) {
        self.resource_call(method, 1..=1, response);
    }

    pub fn expect_pending_recheck(&self) {
        self.resource_call("GET", 1..=1, reply(200, example("accepted")));
    }

    fn resource_call(
        &self,
        method: &'static str,
        times: std::ops::RangeInclusive<usize>,
        response: impl Responder + 'static,
    ) {
        self.server.expect(
            Expectation::matching(all_of![
                request::method_path(method, format!("{COLLECTION}/{ID}")),
                request::headers(contains(("authorization", format!("Bearer {KEY}")))),
                request::body("")
            ])
            .times(times)
            .respond_with(response),
        );
    }

    // A checkpoint also rejects unexpected requests. Installing only the next
    // phase's expectation prevents an early GET from satisfying a later step.
    pub fn verify(&mut self) {
        self.server.verify_and_clear();
    }
}
