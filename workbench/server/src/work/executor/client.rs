//! 每次工具调用独享一个 stdio 会话，不重放可能已经执行的请求。
use crate::work::Error;
use serde_json::{Value, json};
use std::{io, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    time::timeout,
};

const VERSION: &str = "2025-06-18";
const TRUSTED_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
const LINE_LIMIT: usize = 4 * 1024 * 1024; // 包括 JSONL 换行符
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

fn unavailable() -> Error {
    Error::Unavailable("执行器不可用或协议响应无效".into())
}

pub(super) async fn call(bin: &Path, root: &Path, tool: &str, args: Value) -> Result<Value, Error> {
    if !bin.is_absolute() || !args.is_object() {
        return Err(unavailable());
    }
    let mut cmd = Command::new(bin);
    cmd.env_clear()
        .env("PATH", TRUSTED_PATH)
        .env("URSI_EXECUTOR_ROOT", root);
    for key in [
        "URSI_EXECUTOR_FLOW",
        "URSI_EXECUTOR_FLOW_REVISION",
        "URSI_FLOW_HOME",
    ] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| unavailable())?;
    run(&mut child, tool, args, CALL_TIMEOUT).await
}

async fn run(
    child: &mut Child,
    tool: &str,
    args: Value,
    deadline: Duration,
) -> Result<Value, Error> {
    let exchange = async {
        let mut input = child.stdin.take().ok_or_else(unavailable)?;
        let mut output = BufReader::new(child.stdout.take().ok_or_else(unavailable)?);
        send(
            &mut input,
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
                "protocolVersion":VERSION,"capabilities":{},
                "clientInfo":{"name":"ursi-workbench","version":env!("CARGO_PKG_VERSION")}
            }}),
        )
        .await?;
        let init = response(&mut output, 1).await?;
        if init["protocolVersion"] != VERSION
            || !init["capabilities"]["tools"].is_object()
            || !init["serverInfo"]["name"].is_string()
            || !init["serverInfo"]["version"].is_string()
        {
            return Err(unavailable());
        }
        send(
            &mut input,
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await?;
        let mut request =
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":tool}});
        request["params"]["arguments"] = args;
        send(&mut input, request).await?;
        let result = response(&mut output, 2).await?;
        drop(input); // MCP stdio 通过关闭 stdin 请求服务端退出。
        drop(output);
        if !child.wait().await.map_err(|_| unavailable())?.success() {
            return Err(unavailable());
        }
        Ok(result)
    };
    match timeout(deadline, exchange).await {
        Ok(Ok(result)) => tool_result(result),
        _ => {
            // kill() 同时回收子进程。调用方取消时另由 kill_on_drop 兜底。
            let _ = timeout(Duration::from_secs(1), child.kill()).await;
            Err(unavailable())
        }
    }
}

struct Frame(Vec<u8>);
impl io::Write for Frame {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() >= LINE_LIMIT - self.0.len() {
            return Err(io::Error::other("frame too large"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
async fn send(input: &mut ChildStdin, message: Value) -> Result<(), Error> {
    let mut frame = Frame(Vec::new());
    serde_json::to_writer(&mut frame, &message).map_err(|_| unavailable())?;
    frame.0.push(b'\n');
    input.write_all(&frame.0).await.map_err(|_| unavailable())
}

async fn response(reader: &mut (impl AsyncBufRead + Unpin), id: u64) -> Result<Value, Error> {
    // 合法通知不占用响应 ID，但与响应共享同一字节预算。
    let mut remaining = LINE_LIMIT as u64;
    let mut buf = Vec::new();
    for _ in 0..32 {
        buf.clear();
        let n = (&mut *reader)
            .take(remaining)
            .read_until(b'\n', &mut buf)
            .await
            .map_err(|_| unavailable())?;
        if buf.last() != Some(&b'\n') {
            return Err(unavailable());
        }
        remaining -= n as u64;
        let mut msg: Value = serde_json::from_slice(&buf).map_err(|_| unavailable())?;
        if msg["jsonrpc"] != "2.0" || msg.get("error").is_some() {
            return Err(unavailable());
        }
        if msg.get("id").is_none()
            && msg["method"]
                .as_str()
                .is_some_and(|s| s.starts_with("notifications/"))
            && msg.get("result").is_none()
            && msg.get("params").is_none_or(Value::is_object)
        {
            continue;
        }
        if msg["id"].as_u64() != Some(id)
            || msg.get("method").is_some()
            || !msg["result"].is_object()
        {
            return Err(unavailable());
        }
        return Ok(msg["result"].take());
    }
    Err(unavailable())
}

fn tool_result(mut result: Value) -> Result<Value, Error> {
    let content = result["content"].as_array().ok_or_else(unavailable)?;
    match result.get("isError") {
        None | Some(Value::Bool(false)) if result["structuredContent"].is_object() => {
            Ok(result["structuredContent"].take())
        }
        Some(Value::Bool(true)) => {
            let [part] = content.as_slice() else {
                return Err(unavailable());
            };
            if part["type"] != "text" {
                return Err(unavailable());
            }
            let detail: Value =
                serde_json::from_str(part["text"].as_str().ok_or_else(unavailable)?)
                    .map_err(|_| unavailable())?;
            Err(match detail["code"].as_str() {
                Some("invalid") => Error::Invalid("执行器拒绝了无效请求".into()),
                Some("conflict") => Error::Conflict("执行器状态冲突".into()),
                Some("not_found") => Error::NotFound("执行器未找到请求的对象".into()),
                Some("busy") => Error::Unavailable("执行器繁忙".into()),
                Some("unavailable") => Error::Unavailable("执行器不可用".into()),
                _ => unavailable(),
            })
        }
        _ => Err(unavailable()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[tokio::test]
    async fn private_stdio_round_trip() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&root).unwrap();
        let bin = root.join("private mcp");
        fs::write(&bin, r#"#!/usr/bin/python3
import json, os, sys
assert len(sys.argv) == 1
assert os.environ['URSI_EXECUTOR_ROOT'] == os.path.dirname(sys.argv[0])
# Python may coerce the C locale by setting LC_CTYPE at startup.
assert not set(os.environ) - {'LC_CTYPE','PATH','URSI_EXECUTOR_ROOT','URSI_EXECUTOR_FLOW','URSI_EXECUTOR_FLOW_REVISION','URSI_FLOW_HOME'}
assert os.environ['PATH'] == '/usr/local/bin:/usr/bin:/bin'
def reply(request, result):
    print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}), flush=True)
a = json.loads(input())
assert a['jsonrpc'] == '2.0' and a['method'] == 'initialize' and a['params']['protocolVersion'] == '2025-06-18'
reply(a, {'protocolVersion':'2025-06-18','serverInfo':{'name':'fixture','version':'1'},'capabilities':{'tools':{}}})
assert json.loads(input()) == {'jsonrpc':'2.0','method':'notifications/initialized'}
b = json.loads(input())
assert b['method'] == 'tools/call' and b['params']['name'] == 'inspect' and b['id'] != a['id']
reply(b, {'content':[],'structuredContent':b['params']['arguments']})
assert sys.stdin.read() == ''
"#).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
        let args = json!({"text":"一行\n另一行 \"$()\""});
        let result = call(&bin, &root, "inspect", args.clone()).await;
        fs::remove_dir_all(root).unwrap();
        assert_eq!(result.unwrap(), args);
    }

    #[test]
    fn tool_errors_are_typed_without_echoing_executor_text() {
        for code in [
            "invalid",
            "conflict",
            "not_found",
            "busy",
            "unavailable",
            "other",
        ] {
            let detail = json!({"code":code,"message":"private detail"});
            let result =
                json!({"isError":true,"content":[{"type":"text","text":detail.to_string()}]});
            let error = tool_result(result).unwrap_err();
            assert!(!format!("{error:?}").contains("private detail"));
            assert!(matches!(
                (code, error),
                ("invalid", Error::Invalid(_))
                    | ("conflict", Error::Conflict(_))
                    | ("not_found", Error::NotFound(_))
                    | ("busy" | "unavailable" | "other", Error::Unavailable(_))
            ));
        }
        for result in [
            json!({"content":[]}),
            json!({"structuredContent":[],"content":[]}),
            json!({"isError":"false","content":[],"structuredContent":{}}),
            json!({"isError":true,"content":[{"type":"text","text":"invalid"}],"structuredContent":{}}),
        ] {
            assert!(matches!(tool_result(result), Err(Error::Unavailable(_))));
        }
    }

    #[tokio::test]
    async fn rejects_invalid_or_oversize_frames() {
        for line in [
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{},\"error\":null}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":[]}\n",
            "not-json\n",
        ] {
            assert!(matches!(
                response(&mut line.as_bytes(), 1).await,
                Err(Error::Unavailable(_))
            ));
        }
        let mut bytes = vec![b' '; LINE_LIMIT];
        bytes.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n");
        let mut reader = &bytes[..];
        assert!(matches!(
            response(&mut reader, 1).await,
            Err(Error::Unavailable(_))
        ));
        assert_eq!(reader, &bytes[LINE_LIMIT..]);
        assert!(serde_json::to_writer(Frame(Vec::new()), &"x".repeat(LINE_LIMIT)).is_err());
    }

    #[tokio::test]
    async fn stalled_child_is_reaped() {
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        assert!(matches!(
            run(&mut child, "inspect", json!({}), Duration::from_millis(50)).await,
            Err(Error::Unavailable(_))
        ));
        assert!(child.try_wait().unwrap().is_some());
    }
}
