//! Each tool call gets an independent stdio session and never replays a possibly executed request.
mod stdio;

use super::binding::{Backend, FLOW_ENV};
use crate::work::{Error, mcp_client_info};
use rmcp::{
    ServiceExt,
    model::{CallToolRequestParams, CallToolResponse, CallToolResult, ProtocolVersion},
};
use serde_json::Value;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    process::{Child, Command},
    time::timeout,
};

const VERSION: ProtocolVersion = ProtocolVersion::V_2025_06_18;
const TRUSTED_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

fn unavailable() -> Error {
    Error::Unavailable("执行器不可用或协议响应无效".into())
}

pub(super) async fn call(
    backend: &Backend,
    root: &Path,
    tool: &str,
    args: Value,
) -> Result<Value, Error> {
    if !backend.bin().is_absolute() || !args.is_object() {
        return Err(unavailable());
    }
    let mut cmd = Command::new(backend.bin());
    cmd.env_clear()
        .env("PATH", TRUSTED_PATH)
        .env("URSI_EXECUTOR_ROOT", root);
    match backend {
        Backend::Flow { env, .. } => {
            for (key, value) in FLOW_ENV.into_iter().zip(env) {
                if let Some(value) = value {
                    cmd.env(key, value);
                }
            }
        }
        Backend::Pi { policy, .. } => {
            cmd.env("URSI_PI_POLICY", policy);
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
        let input = child.stdin.take().ok_or_else(unavailable)?;
        let output = child.stdout.take().ok_or_else(unavailable)?;
        let mut session = mcp_client_info(VERSION)
            .serve(stdio::Stdio::new(output, input))
            .await
            .map_err(|_| unavailable())?;
        let init = session.peer_info().ok_or_else(unavailable)?;
        if init.protocol_version != VERSION
            || init.capabilities.tools.is_none()
            || init.server_info.is_none()
        {
            return Err(unavailable());
        }
        let Value::Object(args) = args else {
            return Err(unavailable());
        };
        let params = CallToolRequestParams::new(tool.to_owned()).with_arguments(args);
        let CallToolResponse::Complete(result) = session
            .call_tool_once(params)
            .await
            .map_err(|_| unavailable())?
        else {
            return Err(unavailable());
        };
        session.close().await.map_err(|_| unavailable())?;
        if !child.wait().await.map_err(|_| unavailable())?.success() {
            return Err(unavailable());
        }
        Ok(result)
    };
    match timeout(deadline, exchange).await {
        Ok(Ok(result)) => tool_result(result),
        _ => {
            let _ = timeout(Duration::from_secs(1), child.kill()).await;
            Err(unavailable())
        }
    }
}

fn tool_result(result: CallToolResult) -> Result<Value, Error> {
    match result.is_error {
        None | Some(false) => result
            .structured_content
            .filter(Value::is_object)
            .ok_or_else(unavailable),
        Some(true) => {
            let [part] = result.content.as_slice() else {
                return Err(unavailable());
            };
            let text = part.as_text().ok_or_else(unavailable)?;
            let detail: Value = serde_json::from_str(&text.text).map_err(|_| unavailable())?;
            Err(match detail["code"].as_str() {
                Some("invalid") => Error::Invalid("执行器拒绝了无效请求".into()),
                Some("conflict") => Error::Conflict("执行器状态冲突".into()),
                Some("not_found") => Error::NotFound("执行器未找到请求的对象".into()),
                Some("busy") => Error::Unavailable("执行器繁忙".into()),
                Some("unavailable") => Error::Unavailable("执行器不可用".into()),
                _ => unavailable(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[tokio::test]
    async fn private_pi_environment_round_trip() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&root).unwrap();
        let bin = root.join("private pi");
        let policy = root.join("policy");
        fs::write(&policy, "{}").unwrap();
        fs::set_permissions(&policy, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&bin, r#"#!/usr/bin/python3
import json, os, sys
assert not set(os.environ) - {'LC_CTYPE', 'PATH', 'URSI_EXECUTOR_ROOT', 'URSI_PI_POLICY'}
assert os.environ['URSI_PI_POLICY'] == sys.argv[0].rsplit('/', 1)[0] + '/policy'
assert os.environ['URSI_EXECUTOR_ROOT'] == sys.argv[0].rsplit('/', 1)[0]
assert os.environ['PATH'] == '/usr/local/bin:/usr/bin:/bin'
def reply(request, result): print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}), flush=True)
a=json.loads(input()); reply(a, {'protocolVersion':'2025-06-18','serverInfo':{'name':'pi','version':'1'},'capabilities':{'tools':{}}})
assert json.loads(input())['method'] == 'notifications/initialized'
b=json.loads(input()); reply(b, {'content':[], 'structuredContent':b['params']['arguments']})
assert sys.stdin.read() == ''
"#).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
        let backend = Backend::Pi {
            bin: bin.clone(),
            policy,
        };
        let args = json!({"attemptId":"x"});
        assert_eq!(
            call(&backend, &root, "inspect", args.clone())
                .await
                .unwrap(),
            args
        );
        fs::remove_dir_all(root).unwrap();
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
            let error = tool_result(serde_json::from_value(result).unwrap()).unwrap_err();
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
            assert!(matches!(
                serde_json::from_value(result)
                    .map_err(|_| unavailable())
                    .and_then(tool_result),
                Err(Error::Unavailable(_))
            ));
        }
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
