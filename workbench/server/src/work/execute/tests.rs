mod http;

use super::*;
use std::{fs, os::unix::fs::PermissionsExt, path::Path as FsPath, time::Duration};

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
        "analyze":{"executor":{"id":"assistant","revision":3,"kind":"agent"},"resources":[
            {"id":"summary","revision":1,"kind":"prompt","content":"报告须有标题"},
            {"id":"review","revision":2,"kind":"skill","content":"检查最后一行"}]},
        "verify":{"executor":{"id":"verify","revision":2,"kind":"flow","flowId":"verification","flowRevision":"f123"},"resources":[]}}}})
}

#[test]
fn resolve_only_the_frozen_action_and_supported_capabilities() {
    let mut i = item();
    let (plan::Plan::Agent(prompt), _) = plan::resolve(&i, "analyze").unwrap() else {
        panic!()
    };
    for s in ["A-17", "对照原始材料", "报告须有标题", "检查最后一行"] {
        assert!(prompt.contains(s));
    }
    let (
        plan::Plan::Flow {
            id,
            revision,
            variables,
        },
        _,
    ) = plan::resolve(&i, "verify").unwrap()
    else {
        panic!()
    };
    assert_eq!(
        (id.as_str(), revision.as_str(), variables),
        ("verification", "f123", i["input"].clone())
    );
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
fn restart_marks_only_unfinished_attempts() {
    let mut db = json!({"items":{"a":{"attempts":[{"status":"starting"},{"status":"running"},{"status":"succeeded","output":"evidence"}]}}});
    recover(&mut db).unwrap();
    recover(&mut db).unwrap();
    let attempts = history(&db, "a").unwrap();
    assert_eq!(attempts[0]["status"], "unverified");
    assert_eq!(attempts[1]["status"], "unverified");
    assert_eq!(
        attempts[2],
        json!({"status":"succeeded","output":"evidence"})
    );
}

#[test]
fn stop_needs_daemon_evidence_for_this_exact_run() {
    let a = json!({"id":"a","executor":{"flowId":"f","flowRevision":"rev"}});
    let mut job = json!({"id":"a","flow":"f","revision":"rev"});
    for (reported, expected) in [
        ("running", "running"),
        ("completed", "succeeded"),
        ("failed", "failed"),
        ("stopped", "cancelled"),
        ("unknown", "unverified"),
        ("unrecognized", "unverified"),
    ] {
        job["status"] = reported.into();
        assert_eq!(flow::evidence(&a, &job).status, expected);
    }
    job["status"] = "completed".into();
    job["revision"] = "other".into();
    assert_eq!(flow::evidence(&a, &job).status, "unverified");
}

#[tokio::test]
async fn pi_reads_one_prompt_in_admin_workspace_and_does_not_inherit_server_token() {
    let temp = Temp::new();
    let bin = temp.script(
        r#"test "${URSI_API_TOKEN+x}" != x
test "$*" = '--print --mode text --no-session --no-tools --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --no-approve'
pwd
cat"#,
    );
    let (_tx, mut rx) = watch::channel(false);
    let prompt = "@not-a-path\n--not-an-argument\n$(printf no)";
    let out = agent::run(&bin, &temp.0, prompt.into(), &mut rx, READY_LIMIT).await;
    assert_eq!(out.status, "succeeded", "{}", out.output);
    assert_eq!(out.output, format!("{}\n{prompt}", temp.0.display()));
}

#[tokio::test]
async fn overflow_on_either_pipe_is_a_failure() {
    let temp = Temp::new();
    let (_tx, mut rx) = watch::channel(false);
    for redirection in ["", ">&2"] {
        let bin = temp.script(&format!(
            "cat >/dev/null\nhead -c 65537 /dev/zero {redirection}"
        ));
        let out = agent::run(&bin, &temp.0, "abc".into(), &mut rx, READY_LIMIT).await;
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
            agent::run(&bin, &temp.0, "abc".into(), &mut rx, timeout),
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
