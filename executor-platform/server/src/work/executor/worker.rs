//! One detached platform worker owns the ACP connection for an attempt.
use super::{
    binding,
    client::Connection,
    journal::{self, Trace},
};
use crate::work::Error;
use serde_json::{Value, json};
use std::{
    io::{self, Read, Write},
    path::Path,
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::{Instant, sleep, timeout};
use uuid::Uuid;

const CLAIM: Duration = Duration::from_secs(3);
const SETUP: Duration = Duration::from_secs(10);
const RUN: Duration = Duration::from_secs(30 * 60);
const GRACE: Duration = Duration::from_secs(5);
const RECEIPT_GRACE: Duration = Duration::from_secs(2);
const SLOTS: usize = 16;

pub(super) async fn launch(root: &Path, id: &str, bin: &Path, policy: &Path) -> io::Result<()> {
    let mut child = tokio::process::Command::new(std::env::current_exe()?)
        .arg("--acp-worker")
        .arg(root)
        .arg(id)
        .arg(bin)
        .arg(policy)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()?;
    let mut input = child.stdin.take().expect("worker stdin is piped");
    let mut output = child.stdout.take().expect("worker stdout is piped");
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    // EOF before the release byte prevents a late worker from ever starting Pi.
    timeout(CLAIM, async {
        if output.read_u8().await? != 1 {
            return Err(io::Error::other("ACP worker did not claim"));
        }
        input.write_u8(1).await
    })
    .await?
}

pub(crate) async fn work(root: &Path, id: &str, bin: &Path, policy: &Path) -> io::Result<()> {
    if !root.is_absolute() || !Uuid::parse_str(id).is_ok_and(|u| u.to_string() == id) {
        return Err(io::Error::other("invalid ACP worker identity"));
    }
    let dir = root.join(id);
    let _lock = journal::lock(&dir.join("acp-worker.lock"), true)?;
    let claimed = dir.join("acp-claimed.json");
    if journal::read(&claimed, 1024)?.is_some() {
        return Ok(());
    }
    journal::write(&claimed, &json!(true))?;
    io::stdout().write_all(&[1])?;
    io::stdout().flush()?;
    let mut release = [0];
    io::stdin().read_exact(&mut release)?;
    if release != [1] {
        return Err(io::Error::other("invalid ACP worker release"));
    }
    let _slot = (0..SLOTS)
        .find_map(|slot| journal::lock(&root.join(format!("acp-slot-{slot}")), true).ok());
    if _slot.is_none() {
        return record_result(&dir, "failed", true);
    }
    let request = journal::read(&dir.join("acp-request.json"), 512 * 1024)?
        .ok_or_else(|| io::Error::other("missing ACP request"))?;
    let job = dir.join("acp-job.json");
    let config = binding::read_snapshot(root, id, request["configDigest"].as_str().unwrap_or(""))
        .map_err(|_| io::Error::other("invalid ACP snapshot"))?;
    let mut trace = Trace::new();
    let (done, stopped) = if requested(&dir) {
        ("cancelled", true)
    } else if let Ok(mut conn) = Connection::spawn(bin, policy, root, Some(&job)) {
        let status = execute(&mut conn, &dir, &request, &config, &mut trace).await;
        if conn.stop().await {
            (status, true)
        } else {
            ("unverified", false)
        }
    } else {
        ("failed", true)
    };
    if done == "unverified" {
        trace.gap(&dir, "execution_unverified");
    }
    record_result(&dir, done, stopped)
}

fn record_result(dir: &Path, status: &str, stopped: bool) -> io::Result<()> {
    journal::write(
        &dir.join("acp-result.json"),
        &json!({"status":status,"writersStopped":stopped}),
    )
}

fn requested(dir: &Path) -> bool {
    dir.join("acp-cancel.json").exists()
}

fn unavailable() -> Error {
    binding::unavailable()
}

fn opaque(v: &Value) -> Option<&str> {
    v.as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
}

async fn control(conn: &mut Connection, message: &Value) -> Result<bool, Error> {
    if message["jsonrpc"] != "2.0" {
        return Err(unavailable());
    }
    let Some(method) = message["method"].as_str() else {
        return Ok(false);
    };
    if let Some(id) = message.get("id") {
        if !id.is_string() && !id.is_i64() {
            return Err(unavailable());
        }
        let response = if method == "session/request_permission" {
            json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}})
        } else {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})
        };
        conn.send(response).await?;
        return Ok(true);
    }
    Ok(method != "session/update")
}

async fn open(
    conn: &mut Connection,
    dir: &Path,
    config: &Value,
) -> Result<(String, Vec<Value>, bool), Error> {
    conn.initialize().await?;
    let text = config["systemPrompt"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(unavailable)?;
    conn.send(json!({"jsonrpc":"2.0","id":"new","method":"session/new","params":{
        "cwd":dir.join("workspace"),"systemPrompt":{"mode":"override","content":[{"type":"text","text":text}]}
    }})).await?;
    let mut early = Vec::new();
    let mut bytes = 0;
    let mut gap = false;
    loop {
        let message = conn.recv().await?;
        if control(conn, &message).await? {
            continue;
        }
        if message["id"] == "new"
            && message.get("method").is_none()
            && message.get("error").is_none()
        {
            let sid = opaque(&message["result"]["sessionId"]).ok_or_else(unavailable)?;
            return Ok((sid.to_owned(), early, gap));
        }
        if message["method"] != "session/update" {
            return Err(unavailable());
        }
        let params = &message["params"];
        bytes += serde_json::to_vec(params).map_err(|_| unavailable())?.len();
        if early.len() < 32 && bytes <= 128 * 1024 {
            early.push(params.clone());
        } else {
            gap = true;
        }
    }
}

async fn execute(
    conn: &mut Connection,
    dir: &Path,
    request: &Value,
    config: &Value,
    trace: &mut Trace,
) -> &'static str {
    let Ok(Ok((sid, early, gap))) = timeout(SETUP, open(conn, dir, config)).await else {
        return if requested(dir) {
            "cancelled"
        } else {
            "failed"
        };
    };
    let protected: Vec<_> = std::iter::once(&config["systemPrompt"])
        .chain(
            config["skills"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| &s["content"]),
        )
        .filter_map(Value::as_str)
        .filter(|s| !s.is_empty())
        .collect();
    let key = Uuid::new_v4().to_string();
    let session = dir.join("acp-session.json");
    let mut state = Turn::default();
    let status = async {
        journal::write(&session, &json!({"sessionId":sid})).map_err(|_| unavailable())?;
        for p in early { if p["sessionId"] == sid { observe(dir, trace, &p["update"], &protected); } }
        if gap { trace.gap(dir, "early_update_limit"); }
        if requested(dir) { return Ok("cancelled"); }
        journal::write(&session, &json!({"sessionId":sid,"idempotencyKey":key})).map_err(|_| unavailable())?;
        state.submitted = true;
        conn.send(json!({"jsonrpc":"2.0","id":"prompt","method":"session/prompt","params":{
            "sessionId":sid,"idempotencyKey":key,"prompt":[{"type":"text","text":request["instruction"]}]
        }})).await?;
        drive(conn, dir, &sid, trace, &protected, &mut state).await
    }.await.unwrap_or("unverified");
    let saved = journal::write(
        &session,
        &json!({
            "sessionId":sid,"idempotencyKey":state.submitted.then_some(key),
            "messageId":state.ack.or(state.echo),"stopReason":state.stop_reason,
            "terminalStatus":status
        }),
    )
    .is_ok();
    let _ = timeout(Duration::from_secs(2), async {
        conn.send(json!({"jsonrpc":"2.0","id":"close","method":"session/close","params":{"sessionId":sid}})).await?;
        loop {
            let m = conn.recv().await?;
            if control(conn, &m).await? { continue; }
            if m["id"] == "close" && m.get("method").is_none() { break; }
            if m["method"] == "session/update" && m["params"]["sessionId"] == sid {
                observe(dir, trace, &m["params"]["update"], &protected);
            }
        }
        Ok::<(),Error>(())
    }).await;
    if saved { status } else { "unverified" }
}

#[derive(Default)]
struct Turn {
    submitted: bool,
    ack: Option<String>,
    echo: Option<String>,
    active: bool,
    terminal: Option<&'static str>,
    stop_reason: Option<String>,
    stop_at: Option<Instant>,
}

impl Turn {
    fn update(&mut self, u: &Value) -> Result<(), Error> {
        match u["sessionUpdate"].as_str() {
            Some("user_message" | "user_message_chunk") => {
                let id = opaque(&u["messageId"]).ok_or_else(unavailable)?;
                if self
                    .echo
                    .as_deref()
                    .or(self.ack.as_deref())
                    .is_some_and(|v| v != id)
                {
                    return Err(unavailable());
                }
                self.echo = Some(id.to_owned());
            }
            Some("state_update") if self.terminal.is_none() => match u["state"].as_str() {
                Some("running" | "requires_action") => {
                    self.active = true;
                    self.stop_at = None;
                }
                Some("unknown") => self.active = false,
                Some("idle") if self.active => {
                    self.active = false;
                    // An idle before insertion cannot certify this turn.
                    self.stop_at = Some(Instant::now());
                    if self.ack.is_none() && self.echo.is_none() {
                        return Ok(());
                    }
                    self.stop_reason = u["stopReason"]
                        .as_str()
                        .filter(|s| s.len() <= 32)
                        .map(str::to_owned);
                    self.terminal = Some(match self.stop_reason.as_deref() {
                        Some("end_turn") => "succeeded",
                        Some("cancelled") => "cancelled",
                        Some("error" | "refusal" | "max_tokens" | "max_turn_requests") => "failed",
                        _ => "unverified",
                    });
                }
                _ => (),
            },
            _ => (),
        }
        Ok(())
    }
}

async fn drive(
    conn: &mut Connection,
    dir: &Path,
    sid: &str,
    trace: &mut Trace,
    protected: &[&str],
    state: &mut Turn,
) -> Result<&'static str, Error> {
    let mut deadline = Instant::now() + RUN;
    let mut cancelled = false;
    let mut timed_out = false;
    let mut count = 0;
    loop {
        let now = Instant::now();
        let receipt_expired = state.stop_at.is_some_and(|at| now >= at + RECEIPT_GRACE);
        if let Some(status) = state
            .terminal
            .filter(|_| state.ack.is_some() || receipt_expired)
        {
            return Ok(if timed_out && status == "cancelled" {
                "failed"
            } else {
                status
            });
        }
        // Poll control even when an agent floods its stdout.
        if receipt_expired && !state.active {
            return Ok("unverified");
        }
        let expired = now >= deadline;
        if expired && cancelled {
            return Ok("unverified");
        }
        if !cancelled && state.terminal.is_none() && (expired || requested(dir)) {
            cancelled = true;
            timed_out = expired;
            deadline = Instant::now() + GRACE;
            conn.send(
                json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":sid}}),
            )
            .await?;
        }
        let m = tokio::select! {
            msg = conn.recv_next() => match msg? { Some(m) => m, None => {
                trace.gap(dir, "transport_closed");
                return Ok(state.terminal.unwrap_or("unverified"));
            } },
            _ = sleep(Duration::from_millis(100)) => continue,
        };
        count += 1;
        if count > 32_768 {
            return Err(unavailable());
        }
        if control(conn, &m).await? {
            continue;
        }
        if m["method"] == "session/update" {
            let p = &m["params"];
            if p["sessionId"] != sid {
                continue;
            }
            state.update(&p["update"])?;
            observe(dir, trace, &p["update"], protected);
            continue;
        }
        if m["id"] != "prompt" || state.ack.is_some() {
            return Err(unavailable());
        }
        match (m.get("result"), m.get("error")) {
            (Some(result), None) => {
                let id = opaque(&result["messageId"]).ok_or_else(unavailable)?;
                if state.echo.as_deref().is_some_and(|v| v != id) {
                    return Err(unavailable());
                }
                state.ack = Some(id.to_owned());
            }
            (None, Some(error)) if state.echo.is_none() && error["code"].is_i64() => {
                return Ok(if cancelled && !timed_out && error["code"] == -32800 {
                    "cancelled"
                } else {
                    "failed"
                });
            }
            _ => return Err(unavailable()),
        }
    }
}

fn text(
    v: &Value,
    max: usize,
    protected: &[&str],
    dir: &Path,
    trace: &mut Trace,
) -> Option<String> {
    let s = v.as_str()?;
    // Pi already redacts across deltas. Bound this second filter before copying.
    if s.len() > 16 * 1024 {
        trace.gap(dir, "event_size_limit");
        return None;
    }
    let mut text = s
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect::<String>();
    if protected.iter().any(|p| text.contains(p)) {
        return Some("[redacted]".into());
    }
    if let Some((pos, _)) = text.char_indices().nth(max) {
        trace.gap(dir, "event_size_limit");
        text.truncate(pos);
    }
    Some(text)
}

fn observe(dir: &Path, trace: &mut Trace, u: &Value, protected: &[&str]) {
    let event = match u["sessionUpdate"].as_str() {
        Some("state_update")
            if matches!(
                u["state"].as_str(),
                Some("running" | "idle" | "requires_action" | "unknown")
            ) =>
        {
            let mut e = json!({"kind":"state","state":u["state"]});
            if matches!(
                u["stopReason"].as_str(),
                Some(
                    "end_turn"
                        | "cancelled"
                        | "error"
                        | "refusal"
                        | "max_tokens"
                        | "max_turn_requests"
                )
            ) {
                e["stopReason"] = u["stopReason"].clone();
            }
            e
        }
        Some("agent_message" | "agent_message_chunk") => {
            let Some(id) = opaque(&u["messageId"]) else {
                return;
            };
            let mut parts = Vec::new();
            let blocks = if u["sessionUpdate"] == "agent_message_chunk" {
                std::slice::from_ref(&u["content"])
            } else {
                u["content"].as_array().map_or(&[][..], Vec::as_slice)
            };
            if blocks.iter().all(|b| b["type"] != "text") && u.get("content").is_none() {
                return;
            }
            for b in blocks.iter().take(4).filter(|b| b["type"] == "text") {
                if let Some(t) = text(&b["text"], 512, protected, dir, trace) {
                    parts.push(t);
                }
            }
            json!({"kind":"message","messageId":id,"chunk":u["sessionUpdate"]=="agent_message_chunk","text":parts.join("\n")})
        }
        Some("tool_call_update") => {
            let Some(id) = opaque(&u["toolCallId"]) else {
                return;
            };
            let mut e = json!({"kind":"tool","toolCallId":id});
            if let Some(name) = text(
                u.get("name").unwrap_or(&u["title"]),
                128,
                protected,
                dir,
                trace,
            ) {
                e["name"] = json!(name);
            }
            if matches!(
                u["status"].as_str(),
                Some("pending" | "in_progress" | "completed" | "failed" | "paused" | "cancelled")
            ) {
                e["status"] = u["status"].clone();
            }
            e
        }
        _ => return,
    };
    if trace.append(dir, event).is_err() {
        trace.gap(dir, "event_write_failed");
    }
}
