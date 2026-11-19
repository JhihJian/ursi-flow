mod http;

use super::*;
use std::{fs, path::Path as FsPath, time::Duration};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(Uuid::new_v4().to_string());
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(&p).unwrap();
        Self(p)
    }
    fn script(&self, body: &str) -> PathBuf {
        self.executable("fake-pi", &format!("#!/bin/sh\nset -eu\n{body}\n"))
    }
    fn executable(&self, name: &str, contents: &str) -> PathBuf {
        // A concurrent fork can inherit a writable fd until exec, causing ETXTBSY.
        // Only the installer opens the executable for writing, and we wait for it to exit.
        let source = self.0.join(format!("{name}.source"));
        let bin = self.0.join(name);
        fs::write(&source, contents).unwrap();
        assert!(
            std::process::Command::new("install")
                .args(["-m", "700"])
                .arg(source)
                .arg(&bin)
                .status()
                .unwrap()
                .success()
        );
        bin
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn item() -> Value {
    json!({"status":"working","input":{"ticket":"A-17"},"attempts":[],"packageSnapshot":{"sop":"对照原始材料","actions":{
        "analyze":{"executor":{"id":"assistant","revision":3},"resources":[
            {"id":"summary","revision":1,"kind":"prompt","content":"报告须有标题"},
            {"id":"review","revision":2,"kind":"skill","content":"检查最后一行"}]},
        "verify":{"executor":{"id":"verify","revision":2,"kind":"flow","flowId":"verification","flowRevision":"f123"},"resources":[]}}}})
}

#[test]
fn resolve_only_the_frozen_action_and_supported_capabilities() {
    let mut i = item();
    let (plan::Plan::Agent(prompt), _) = plan::resolve(&i, "analyze").unwrap();
    for s in ["A-17", "对照原始材料", "报告须有标题", "检查最后一行"] {
        assert!(prompt.contains(s));
    }
    assert!(matches!(
        plan::resolve(&i, "verify"),
        Err(Error::Unavailable(_))
    ));
    assert!(plan::resolve(&i, "missing").is_err());
    i["packageSnapshot"]["actions"]["analyze"]["resources"][0]["kind"] = "mcp".into();
    assert!(plan::resolve(&i, "analyze").is_err());
    i["packageSnapshot"]["actions"]["verify"]["resources"] =
        i["packageSnapshot"]["actions"]["analyze"]["resources"].clone();
    assert!(plan::resolve(&i, "verify").is_err());
    i = item();
    i["packageSnapshot"]["actions"]["verify"]["executor"]["sandbox"] = true.into();
    assert!(plan::resolve(&i, "verify").is_err());
    i["status"] = "review".into();
    assert!(matches!(
        plan::resolve(&i, "analyze"),
        Err(Error::Conflict(_))
    ));
    assert!(
        serde_json::from_value::<Request>(json!({"action":"analyze","bin":"/bin/sh"})).is_err()
    );
}

#[test]
fn attempt_freezes_host_neutral_config_and_redacts_secrets() {
    let mut i = item();
    i["packageSnapshot"]["configPackage"] = json!({
        "sourceRef": {"id":"assistant-config","revision":3},
        "version": "config-v3",
        "values": {"model":"deepseek-flash","temperature":0.2},
        "secrets": {
            "apiKey": {"value":"private-canary"},
            "gateway": {"state":"internal-reference","ref":"vault:gateway"}
        }
    });
    let binding = i["packageSnapshot"]["actions"]["analyze"].clone();
    let first = freeze_config(&i, &binding, "attempt-one").unwrap();
    let second = freeze_config(&i, &binding, "attempt-two").unwrap();

    assert_eq!(first["version"], "config-v3");
    assert_eq!(
        first["sourceRef"],
        json!({"id":"assistant-config","revision":3})
    );
    assert_eq!(
        first["values"],
        json!({"model":"deepseek-flash","temperature":0.2})
    );
    assert_eq!(
        first["secrets"],
        json!({
            "apiKey":{"state":"irreversible"},
            "gateway":{"state":"internalRef"}
        })
    );
    assert!(!first.to_string().contains("private-canary"));
    assert_eq!(
        first["capability"],
        json!({"id":"attempt-one","access":"read-only","purpose":"executor-config"})
    );
    assert_ne!(first["snapshotRef"]["id"], second["snapshotRef"]["id"]);
    assert_ne!(first["capability"]["id"], second["capability"]["id"]);

    i["packageSnapshot"]["configPackage"]["values"]["model"] = "changed".into();
    assert_eq!(first["values"]["model"], "deepseek-flash");
}

#[test]
fn config_reference_rejects_host_paths() {
    let mut i = item();
    i["packageSnapshot"]["configPackage"] =
        json!({"sourceRef":{"id":"/private/config","revision":1}});
    let binding = i["packageSnapshot"]["actions"]["analyze"].clone();
    assert!(matches!(
        freeze_config(&i, &binding, "attempt").unwrap_err(),
        Error::Invalid(_)
    ));
}

#[test]
fn restart_marks_only_unfinished_attempts() {
    let mut db = json!({"items":{"a":{"attempts":[{"status":"starting"},{"status":"running"},{"status":"succeeded","output":"evidence"}]}}});
    recover(&mut db).unwrap();
    recover(&mut db).unwrap();
    let attempts = history(&db, "a").unwrap();
    assert_eq!(attempts[0]["status"], "unverified");
    assert_eq!(attempts[1]["status"], "unverified");
    assert_eq!(attempts[2]["status"], "succeeded");
    assert_eq!(attempts[2]["output"], "evidence");
    // 旧记录补齐执行器契约字段，没有制品目录时保持空引用。
    assert_eq!(attempts[2]["artifactDirectory"], Value::Null);
    assert_eq!(attempts[2]["platformLog"], json!([]));
    assert_eq!(attempts[0]["platformLog"].as_array().unwrap().len(), 1);
}

#[test]
fn recovery_keeps_executor_output_and_records_a_platform_notice() {
    let mut db = json!({"items":{"a":{"attempts":[
        {"id":"old","status":"running","workspace":"/home/host/work","output":"报告草稿在 /home/host/work 下"},
        {"id":"done","status":"succeeded","workspace":"default","output":"已生成报告"},
        {"id":"waiting","status":"running","workspace":{"id":"default","access":"read-write","purpose":"work-input"},
         "artifactDirectory":{"id":"d1","state":"writable"}}]}},
        "directories":{"d1":{"id":"d1","rules":{"fixed":[],"json_objects":[]},"state":"writable"}}});
    recover(&mut db).unwrap();
    // 再次恢复不得追加事件或改变已核实过的形状。
    recover(&mut db).unwrap();
    let attempts = history(&db, "a").unwrap();
    let interrupted = &attempts[0];
    assert_eq!(interrupted["status"], "unverified");
    assert_eq!(interrupted["interruptedStatus"], "running");
    assert_eq!(interrupted["output"], "报告草稿在 [workspace] 下");
    assert_ne!(
        interrupted["output"],
        Value::from("服务已重启，执行可能已有副作用，请核实；不会重发")
    );
    assert_eq!(
        interrupted["recoveryNotice"],
        "服务已重启，执行可能已有副作用，请核实；不会重发"
    );
    assert_eq!(
        interrupted["workspace"],
        json!({"id":"default","access":"read-write","purpose":"work-input"})
    );
    let log = interrupted["platformLog"].as_array().unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0]["event"], "attempt_interrupted");
    assert_eq!(log[0]["source"], "platform");
    assert_eq!(attempts[1]["output"], "已生成报告");
    assert_eq!(attempts[1]["platformLog"], json!([]));
    // 中断的尝试保留制品目录，并与目录记录一起冻结。
    assert_eq!(attempts[2]["status"], "unverified");
    assert_eq!(attempts[2]["artifactDirectory"]["state"], "frozen");
    let db = &db;
    assert_eq!(db["directories"]["d1"]["state"], "frozen");
}

#[test]
fn legacy_backend_snapshots_are_unavailable() {
    let i = item();
    assert!(matches!(
        plan::resolve(&i, "verify"),
        Err(Error::Unavailable(_))
    ));
}

#[tokio::test]
async fn pi_reads_one_prompt_in_admin_workspace_and_does_not_inherit_server_token() {
    let temp = Temp::new();
    let artifacts = temp.0.join("artifacts");
    fs::create_dir(&artifacts).unwrap();
    let bin = temp.script(
        r#"test "${URSI_API_TOKEN+x}" != x
# 执行器只拿到平台分配的制品目录，它位于管理员工作区之下。
test -d "$URSI_ARTIFACT_DIR"
test "$(dirname "$URSI_ARTIFACT_DIR")" = "$PWD"
test "$*" = '--print --mode text --no-session --no-tools --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --no-approve'
pwd
cat"#,
    );
    let (_tx, mut rx) = watch::channel(false);
    let prompt = "@not-a-path\n--not-an-argument\n$(printf no)";
    let out = agent::run(
        &bin,
        &temp.0,
        &artifacts,
        prompt.into(),
        &mut rx,
        READY_LIMIT,
    )
    .await;
    assert_eq!(out.status, "succeeded", "{}", out.output);
    assert_eq!(out.output, format!("{}\n{prompt}", temp.0.display()));
    // 标准输出同时是执行器记录日志。
    assert_eq!(
        out.executor_log,
        Some(("agent", out.output.clone())),
        "{} expected stdout as executor log",
        out.output
    );
}

#[tokio::test]
async fn overflow_on_either_pipe_is_a_failure() {
    let temp = Temp::new();
    let (_tx, mut rx) = watch::channel(false);
    for redirection in ["", ">&2"] {
        let bin = temp.script(&format!(
            "cat >/dev/null\nhead -c 65537 /dev/zero {redirection}"
        ));
        let out = agent::run(&bin, &temp.0, &temp.0, "abc".into(), &mut rx, READY_LIMIT).await;
        assert_eq!(out.status, "failed");
        assert!(out.output.contains("64 KiB"), "{}", out.output);
    }
}

const READY_LIMIT: Duration = Duration::from_secs(20);

async fn wait_file(path: &FsPath) {
    tokio::time::timeout(READY_LIMIT, async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "ready signal missing after {READY_LIMIT:?}: {}",
            path.display()
        )
    });
}

#[tokio::test]
async fn loss_of_control_is_not_a_confirmed_stop_and_never_resends_prompt() {
    let temp = Temp::new();
    let bin = temp.script("cat >> received\ntouch ready\nsleep 30");
    let (tx, mut rx) = watch::channel(false);
    let (out, ()) = tokio::join!(
        agent::run(
            &bin,
            &temp.0,
            &temp.0,
            "once".into(),
            &mut rx,
            READY_LIMIT + Duration::from_secs(10)
        ),
        async {
            wait_file(&temp.0.join("ready")).await;
            drop(tx);
        }
    );
    assert_eq!(out.status, "unverified");
    assert_eq!(fs::read_to_string(temp.0.join("received")).unwrap(), "once");
}

#[tokio::test]
async fn timeout_and_cancel_stop_group_descendants() {
    for cancel in [false, true] {
        let temp = Temp::new();
        let bin = temp.script("cat >/dev/null\n(while [ ! -e probe ]; do sleep 0.05; done; touch escaped) &\ntouch ready\nwait");
        let (tx, mut rx) = watch::channel(false);
        let timeout = if cancel {
            READY_LIMIT + Duration::from_secs(10)
        } else {
            Duration::from_millis(200)
        };
        let (out, ()) = tokio::join!(
            agent::run(&bin, &temp.0, &temp.0, "abc".into(), &mut rx, timeout),
            async {
                if cancel {
                    wait_file(&temp.0.join("ready")).await;
                    tx.send_replace(true);
                }
            }
        );
        assert_eq!(out.status, if cancel { "cancelled" } else { "failed" });
        if !cancel {
            assert!(out.output.contains("超时"), "{}", out.output);
        }
        fs::write(temp.0.join("probe"), "").unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!temp.0.join("escaped").exists());
    }
}
