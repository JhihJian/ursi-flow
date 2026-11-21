mod config;
mod pi;
mod sessions;
mod web;

use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, watch};

#[derive(Debug)]
pub struct RpcError {
    code: i32,
    message: &'static str,
}
impl RpcError {
    fn params(message: &'static str) -> Self {
        Self {
            code: -32602,
            message,
        }
    }
    fn business(message: &'static str) -> Self {
        Self {
            code: -32000,
            message,
        }
    }
    fn cancelled() -> Self {
        Self {
            code: -32800,
            message: "cancelled",
        }
    }
}
fn response(id: Value, result: Result<Value, RpcError>) -> Value {
    match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(error) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":error.code,"message":error.message}})
        }
    }
}
#[derive(Clone)]
pub struct Outbox {
    tx: mpsc::Sender<Value>,
    disconnect: watch::Sender<bool>,
    active: Arc<Mutex<HashSet<String>>>,
}
impl Outbox {
    fn send(&self, message: Value) {
        if let Some(id) = message.get("id") {
            self.active.lock().unwrap().remove(&id.to_string());
        }
        if self.tx.try_send(message).is_err() {
            self.disconnect.send_replace(true);
        }
    }
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|s| s == "--ursi-pi-supervisor") {
        let code = match (
            args.get(2).and_then(|s| serde_json::from_str(s).ok()),
            args.get(3).and_then(|s| s.parse().ok()),
            args.get(4).and_then(|s| s.parse().ok()),
            args.get(5).and_then(|s| s.parse().ok()),
        ) {
            (Some(spec), Some(parent), Some(fd), Some(receipt)) => {
                pi::supervisor::run(spec, parent, fd, receipt)
            }
            _ => 1,
        };
        std::process::exit(code);
    }
    let config = match config::Config::load() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("session-service: {error}");
            std::process::exit(1);
        }
    };
    let sessions = match sessions::Sessions::load(config) {
        Ok(sessions) => sessions,
        Err(error) => {
            eprintln!("session-service: {error}");
            std::process::exit(1);
        }
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime unavailable");
    if runtime.block_on(web::serve(sessions)).is_err() {
        eprintln!("session-service: server failed");
        std::process::exit(1);
    }
}
