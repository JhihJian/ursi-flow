//! Synchronous local Flow Runtime client. One Unix connection per operation.
use serde_json::{Value, json};
use std::{
    io::{self, ErrorKind, Read, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Clone)]
pub struct FlowClient {
    socket: PathBuf,
}
pub type Result<T> = io::Result<T>;
// On a blocking Unix socket SO_RCVTIMEO/SO_SNDTIMEO may report EAGAIN.
fn transport_error(e: io::Error) -> io::Error {
    match e.kind() {
        ErrorKind::WouldBlock => io::Error::new(ErrorKind::TimedOut, e),
        _ => e,
    }
}

fn decode_reply(bytes: &[u8]) -> Result<Value> {
    let invalid = || io::Error::new(ErrorKind::InvalidData, "无效的 Runtime 响应");
    let mut reply: Value =
        serde_json::from_slice(bytes).map_err(|e| io::Error::new(ErrorKind::InvalidData, e))?;
    if reply["v"] != 1 {
        return Err(invalid());
    }
    match (reply.get("data"), reply.get("error"), reply.get("code")) {
        (Some(_), None, None) => Ok(reply["data"].take()),
        (None, Some(Value::String(message)), code) => {
            let kind = match code.map(|v| v.as_str().ok_or_else(invalid)).transpose()? {
                Some("not_found") => ErrorKind::NotFound,
                Some("conflict") => ErrorKind::AlreadyExists,
                Some("busy") => ErrorKind::WouldBlock,
                Some("invalid_input") => ErrorKind::InvalidInput,
                _ => ErrorKind::Other,
            };
            Err(io::Error::new(kind, message.clone()))
        }
        _ => Err(invalid()),
    }
}

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
        let mut socket = UnixStream::connect(&self.socket).map_err(|e| match e.kind() {
            ErrorKind::NotFound => io::Error::new(ErrorKind::ConnectionRefused, e),
            _ => transport_error(e),
        })?;
        socket.set_read_timeout(Some(Duration::from_secs(40)))?;
        socket.set_write_timeout(Some(Duration::from_secs(10)))?;
        serde_json::to_writer(&mut socket, &json!({"v":1,"op":op,"args":args}))
            .map_err(|e| transport_error(e.into()))?;
        socket.write_all(b"\n").map_err(transport_error)?;
        socket
            .shutdown(std::net::Shutdown::Write)
            .map_err(transport_error)?;
        let mut buf = Vec::new();
        socket.read_to_end(&mut buf).map_err(transport_error)?;
        decode_reply(&buf)
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
        self.update_if(id, files, None)
    }
    pub fn update_if(
        &self,
        id: &str,
        files: Value,
        expected_revision: Option<&str>,
    ) -> Result<Value> {
        let mut args = json!({"id":id,"files":files});
        if let Some(revision) = expected_revision {
            args["expectedRevision"] = json!(revision);
        }
        self.request("flow.update", args)
    }
    pub fn delete(&self, id: &str) -> Result<Value> {
        self.request("flow.delete", json!({"id":id}))
    }
    pub fn start(&self, run_id: &str, flow: &str, cwd: &Path, variables: Value) -> Result<Value> {
        self.start_with_executor(run_id, flow, cwd, variables, None, None)
    }
    /// Start only at the specified catalog revision, or return the matching existing run.
    pub fn start_pinned(
        &self,
        run_id: &str,
        flow: &str,
        cwd: &Path,
        variables: Value,
        revision: &str,
    ) -> io::Result<Value> {
        self.start_with_executor(run_id, flow, cwd, variables, Some(revision), None)
    }
    /// Select a published executor for all Agent nodes. The daemon validates the reference.
    pub fn start_with_executor(
        &self,
        run_id: &str,
        flow: &str,
        cwd: &Path,
        variables: Value,
        revision: Option<&str>,
        executor_ref: Option<Value>,
    ) -> Result<Value> {
        // Resolve relative to the client; the daemon checks and canonicalizes the directory.
        let cwd = std::path::absolute(cwd)?;
        let cwd = cwd
            .to_str()
            .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "工作目录不是 UTF-8"))?;
        let mut args = json!({"id":run_id,"flow":flow,"cwd":cwd,"variables":variables});
        if let Some(executor_ref) = executor_ref {
            args["executorRef"] = executor_ref;
        }
        if let Some(revision) = revision {
            args["revision"] = json!(revision);
            self.request("run.startPinned", args)
        } else {
            self.request("run.start", args)
        }
    }
    pub fn resume(&self, id: &str) -> Result<Value> {
        self.request("run.resume", json!({"id":id}))
    }
    /// Answer a Run waiting for human confirmation with one declared result name.
    pub fn respond(&self, id: &str, node_run_id: &str, result: &str) -> Result<Value> {
        self.request(
            "run.respond",
            json!({"id":id,"nodeRunId":node_run_id,"result":result}),
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
    /// 一次 Agent 节点访问的 Pi 会话切片；命令节点没有轨迹文件。
    pub fn trajectory(&self, id: &str, node: &str) -> Result<Value> {
        self.request("run.trajectory", json!({"id":id,"node":node}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn business_kind_depends_only_on_code() {
        for (code, kind) in [
            ("not_found", ErrorKind::NotFound),
            ("conflict", ErrorKind::AlreadyExists),
            ("busy", ErrorKind::WouldBlock),
            ("invalid_input", ErrorKind::InvalidInput),
            ("future_code", ErrorKind::Other),
        ] {
            let reply = json!({"v":1,"error":"same message","code":code});
            assert_eq!(
                decode_reply(reply.to_string().as_bytes())
                    .unwrap_err()
                    .kind(),
                kind
            );
        }
        assert_eq!(
            decode_reply(br#"{"v":1,"error":"invalid input"}"#)
                .unwrap_err()
                .kind(),
            ErrorKind::Other
        );
    }

    #[test]
    fn malformed_replies_are_not_validation_errors() {
        for bytes in [
            "",
            "{",
            "[]",
            r#"{"v":2,"data":0}"#,
            r#"{"v":1}"#,
            r#"{"v":1,"data":1,"error":"bad","code":"invalid_input"}"#,
            r#"{"v":1,"code":"invalid_input"}"#,
            r#"{"v":1,"error":"bad","code":3}"#,
        ] {
            assert_eq!(
                decode_reply(bytes.as_bytes()).unwrap_err().kind(),
                ErrorKind::InvalidData
            );
        }
    }

    #[test]
    fn unix_read_timeout_is_not_runtime_capacity() {
        let (mut reader, _peer) = UnixStream::pair().unwrap();
        reader
            .set_read_timeout(Some(Duration::from_millis(20)))
            .unwrap();
        let error = reader.read_exact(&mut [0]).unwrap_err();
        assert_eq!(transport_error(error).kind(), ErrorKind::TimedOut);
    }

    #[test]
    fn start_pinned_sends_one_conditional_start_and_surfaces_conflict() {
        let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let req: Value = serde_json::from_reader(&mut socket).unwrap();
            assert_eq!(
                req,
                json!({"v":1,"op":"run.startPinned","args":{
                    "id":"attempt", "flow":"example", "cwd":"/work", "variables":{"x":1}, "revision":"rev"
                }})
            );
            socket
                .write_all(br#"{"v":1,"error":"changed","code":"conflict"}"#)
                .unwrap();
        });
        let err = FlowClient::new(&path)
            .start_pinned(
                "attempt",
                "example",
                Path::new("/work"),
                json!({"x":1}),
                "rev",
            )
            .unwrap_err();
        assert_eq!(err.kind(), ErrorKind::AlreadyExists);
        server.join().unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn respond_and_trajectory_send_their_arguments() {
        let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            for (op, args) in [
                (
                    "run.respond",
                    json!({"id":"run", "nodeRunId":"visit", "result":"通过"}),
                ),
                ("run.trajectory", json!({"id":"run", "node":"visit"})),
            ] {
                let (mut socket, _) = listener.accept().unwrap();
                let req: Value = serde_json::from_reader(&mut socket).unwrap();
                assert_eq!(req, json!({"v":1,"op":op,"args":args}));
                socket.write_all(br#"{"v":1,"data":"ok"}"#).unwrap();
            }
        });
        let client = FlowClient::new(&path);
        assert_eq!(client.respond("run", "visit", "通过").unwrap(), "ok");
        assert_eq!(client.trajectory("run", "visit").unwrap(), "ok");
        server.join().unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn update_sends_only_supplied_precondition() {
        let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let client = FlowClient::new(&path);
        assert_eq!(
            client.flows().unwrap_err().kind(),
            ErrorKind::ConnectionRefused
        );
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            for expected in [None, Some("rev")] {
                let (mut socket, _) = listener.accept().unwrap();
                let req: Value = serde_json::from_reader(&mut socket).unwrap();
                let mut args = json!({"id":"example", "files":{}});
                if let Some(revision) = expected {
                    args["expectedRevision"] = json!(revision);
                }
                assert_eq!(req, json!({"v":1,"op":"flow.update","args":args}));
                socket.write_all(br#"{"v":1,"data":"updated"}"#).unwrap();
            }
        });
        assert_eq!(client.update("example", json!({})).unwrap(), "updated");
        assert_eq!(
            client.update_if("example", json!({}), Some("rev")).unwrap(),
            "updated"
        );
        server.join().unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
