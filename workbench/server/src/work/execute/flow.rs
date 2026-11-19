use super::{Error, Outcome};
use serde_json::Value;
use std::{io, path::PathBuf};
use tokio::sync::OwnedSemaphorePermit;
use ursi_flow_client::FlowClient;

pub(super) enum Call {
    Start {
        flow: String,
        revision: String,
        cwd: PathBuf,
        variables: Value,
    },
    Get,
    Stop,
}

pub(super) async fn call(
    client: FlowClient,
    run: String,
    op: Call,
    permit: OwnedSemaphorePermit,
) -> io::Result<Value> {
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        match op {
            Call::Start {
                flow,
                revision,
                cwd,
                variables,
            } => client.start_pinned(&run, &flow, &cwd, variables, &revision),
            Call::Get => client.run(&run),
            Call::Stop => client.stop(&run),
        }
    })
    .await
    .map_err(io::Error::other)?
}

pub(super) fn bound_run(attempt: &Value) -> Result<String, Error> {
    let binding = &attempt["executor"];
    if let Some(run) = attempt["backendRunId"].as_str() {
        if !run.is_empty()
            && attempt["id"] == run
            && ["flowId", "flowRevision"]
                .iter()
                .all(|&k| binding[k].as_str().is_some_and(|s| !s.is_empty()))
        {
            return Ok(run.to_owned());
        }
    }
    Err(Error::Conflict("缺少一致的 Flow 运行绑定".into()))
}

pub(super) enum Observation {
    Reported(Outcome),
    Interrupted(&'static str),
    Inconclusive(&'static str),
}
impl Observation {
    pub(super) fn outcome(self) -> Outcome {
        match self {
            Self::Reported(outcome) => outcome,
            Self::Interrupted(code) => Outcome::new("unverified", format!("daemon: {code}")),
            Self::Inconclusive(reason) => Outcome::new("unverified", reason),
        }
    }
}

// Only run.get for the bound ID can attest absence. The SDK separates a
// versioned daemon not_found reply from a missing socket or transport timeout.
pub(super) fn lookup(attempt: &Value, result: io::Result<Value>) -> Observation {
    match result {
        Ok(job) => classify(attempt, &job),
        Err(e) if e.kind() == io::ErrorKind::NotFound && e.raw_os_error().is_none() => {
            Observation::Interrupted("not_found")
        }
        Err(_) => Observation::Inconclusive("未获得 daemon 的运行证据；请稍后查询"),
    }
}

pub(super) fn evidence(attempt: &Value, job: &Value) -> Outcome {
    classify(attempt, job).outcome()
}
fn classify(attempt: &Value, job: &Value) -> Observation {
    if job["id"] != attempt["id"]
        || job["flow"] != attempt["executor"]["flowId"]
        || job["revision"] != attempt["executor"]["flowRevision"]
    {
        return Observation::Inconclusive("daemon 返回的运行标识或修订不匹配");
    }
    let backend = job["status"].as_str().unwrap_or("");
    let status = match backend {
        "running" => "running",
        "completed" => "succeeded",
        "failed" => "failed",
        "stopped" => "cancelled",
        "unknown" => return Observation::Interrupted("unknown"),
        _ => return Observation::Inconclusive("daemon 未报告已知运行状态"),
    };
    Observation::Reported(Outcome::new(status, format!("daemon: {backend}")))
}

pub(super) fn error(e: &io::Error) -> Error {
    // Daemon diagnostics can include host paths. Expose only the SDK category.
    let message = format!("Flow daemon: {}", e.kind());
    match e.kind() {
        io::ErrorKind::AlreadyExists => Error::Conflict(message),
        io::ErrorKind::InvalidInput => Error::Invalid(message),
        io::ErrorKind::NotFound => Error::NotFound(message),
        _ => Error::Unavailable(message),
    }
}

pub(super) fn rejected(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::AlreadyExists
            | io::ErrorKind::InvalidInput
            | io::ErrorKind::NotFound
            | io::ErrorKind::WouldBlock
    )
}
