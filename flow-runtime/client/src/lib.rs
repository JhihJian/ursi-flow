//! Synchronous local Flow Runtime client. One Unix connection per operation.
use serde_json::{Value, json};
use std::{
    io::{self, Read, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Clone)]
pub struct FlowClient {
    socket: PathBuf,
}
pub type Result<T> = io::Result<T>;
impl FlowClient {
    pub fn new(socket: impl Into<PathBuf>) -> Self {
        Self {
            socket: socket.into(),
        }
    }
    pub fn from_env() -> Result<Self> {
        let home = std::env::var_os("URSI_FLOW_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".ursi-flow")))
            .ok_or(io::Error::other("请设置 URSI_FLOW_HOME"))?;
        Ok(Self::new(home.join("runtime.sock")))
    }
    fn request(&self, op: &str, args: Value) -> Result<Value> {
        let mut socket = UnixStream::connect(&self.socket)?;
        socket.set_read_timeout(Some(Duration::from_secs(40)))?;
        socket.set_write_timeout(Some(Duration::from_secs(10)))?;
        serde_json::to_writer(&mut socket, &json!({"v":1,"op":op,"args":args}))?;
        socket.write_all(b"\n")?;
        socket.shutdown(std::net::Shutdown::Write)?;
        let mut buf = Vec::new();
        socket.read_to_end(&mut buf)?;
        let reply: Value = serde_json::from_slice(&buf)?;
        if reply["v"] != 1 {
            return Err(io::Error::other("无效的 Runtime 响应版本"));
        }
        if let Some(err) = reply["error"].as_str() {
            return Err(io::Error::other(err.to_owned()));
        }
        reply
            .get("data")
            .cloned()
            .ok_or(io::Error::other("Runtime 响应缺少 data"))
    }
    pub fn config(&self) -> Result<Value> {
        self.request("config.get", json!({}))
    }
    pub fn configure(&self, patch: Value) -> Result<Value> {
        self.request("config.update", patch)
    }
    pub fn flows(&self) -> Result<Value> {
        self.request("flow.list", json!({}))
    }
    pub fn flow(&self, id: &str) -> Result<Value> {
        self.request("flow.get", json!({"id":id}))
    }
    pub fn validate(&self, id: &str, files: Value) -> Result<Value> {
        self.request("flow.validate", json!({"id":id,"files":files}))
    }
    pub fn create(&self, id: &str, files: Value) -> Result<Value> {
        self.request("flow.create", json!({"id":id,"files":files}))
    }
    pub fn update(&self, id: &str, files: Value) -> Result<Value> {
        self.request("flow.update", json!({"id":id,"files":files}))
    }
    pub fn delete(&self, id: &str) -> Result<Value> {
        self.request("flow.delete", json!({"id":id}))
    }
    pub fn start(&self, run_id: &str, flow: &str, cwd: &Path, variables: Value) -> Result<Value> {
        self.request(
            "run.start",
            json!({"id":run_id,"flow":flow,"cwd":cwd.canonicalize()?,"variables":variables}),
        )
    }
    pub fn stop(&self, id: &str) -> Result<Value> {
        self.request("run.stop", json!({"id":id}))
    }
    pub fn run(&self, id: &str) -> Result<Value> {
        self.request("run.get", json!({"id":id}))
    }
    pub fn runs(&self) -> Result<Value> {
        self.request("run.list", json!({}))
    }
    pub fn history(&self, id: &str) -> Result<Value> {
        self.request("run.history", json!({"id":id}))
    }
}
