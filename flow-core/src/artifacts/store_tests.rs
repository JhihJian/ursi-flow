//! artifacts 域测试（SPEC 五组验收）。每个测试注释标注对应验收条目。
//!
//! 环境为临时 SQLite 与临时内容目录；rusqlite 同步接口，并发场景经
//! `std::thread` 驱动存储自身串行化（FULLMUTEX + busy_timeout）。

use std::time::Duration;

use crate::domain::ArtifactContract;

use super::store::{ArtifactObject, ArtifactStore};
use super::{check_contract, ArtifactError, ContractCheck};
use crate::storage::{ContentStore, Database};

/// 打开独立验收环境：临时 SQLite + 临时内容目录。
/// TempDir 生命周期随句柄泄漏（测试进程结束由系统回收）。
fn open_store() -> (ArtifactStore, std::path::PathBuf, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("artifacts.db");
    let content_root = dir.path().join("content");
    let db = Database::open(&db_path, super::ARTIFACT_MIGRATIONS).unwrap();
    let content = ContentStore::open(&content_root).unwrap();
    let store = ArtifactStore::new(db, content);
    std::mem::forget(dir);
    (store, db_path, content_root)
}

/// 重新打开存储（验证重开持久性与迁移幂等）。
fn reopen(db_path: &std::path::Path, content_root: &std::path::Path) -> ArtifactStore {
    let db = Database::open(db_path, super::ARTIFACT_MIGRATIONS).unwrap();
    let content = ContentStore::open(content_root).unwrap();
    ArtifactStore::new(db, content)
}

/// 构造写入请求。
fn req(
    run: &str,
    node: &str,
    generation: u64,
    attempt: u64,
    name: &str,
    path: &str,
    bytes: &[u8],
    idem: &str,
) -> super::PutArtifactRequest {
    super::PutArtifactRequest {
        run_id: run.to_string(),
        node_id: node.to_string(),
        generation,
        attempt,
        name: name.to_string(),
        path: path.to_string(),
        bytes: bytes.to_vec(),
        media_type: Some("text/markdown".to_string()),
        required: true,
        idempotency_key: idem.to_string(),
    }
}

/// 契约声明辅助。
fn contract(name: &str, path: &str, required: bool, media_type: Option<&str>) -> ArtifactContract {
    ArtifactContract {
        name: name.to_string(),
        path: path.to_string(),
        required,
        media_type: media_type.map(|s| s.to_string()),
    }
}

// ======== 第 1 组：内容写入与归属记录 ========

/// SPEC「内容写入与归属记录」：写入指定 run/node/generation/attempt 的文件，
/// 读回相同字节与全部归属字段；元数据校验信息一致。
#[test]
fn 写入后读回相同字节与完整归属字段() {
    let (store, _db, _root) = open_store();
    let bytes = "# 报告正文\n".as_bytes().to_vec();
    let record = store
        .put(req("run-1", "node-a", 3, 7, "报告", "out/report.md", &bytes, "idem-1"))
        .unwrap();

    assert_eq!(record.run_id, "run-1");
    assert_eq!(record.node_id, "node-a");
    assert_eq!(record.generation, 3);
    assert_eq!(record.attempt, 7);
    assert_eq!(record.name, "报告");
    assert_eq!(record.path, "out/report.md");
    assert_eq!(record.media_type.as_deref(), Some("text/markdown"));
    assert!(record.required);
    assert_eq!(record.size, bytes.len() as u64);
    assert_eq!(record.sha256, record.content_id);
    assert_eq!(record.idempotency_key, "idem-1");
    assert!(!record.created_at.is_empty());

    let ArtifactObject { record: meta, bytes: got } = store.get(&record.artifact_id).unwrap();
    assert_eq!(got, bytes);
    assert_eq!(meta, record);
    assert_eq!(store.get_meta(&record.artifact_id).unwrap(), record);
}

/// SPEC「内容写入与归属记录」：缺少归属字段返回明确错误，列举中无该失败产物。
#[test]
fn 缺少归属字段的请求被拒且列举无记录() {
    let (store, _db, _root) = open_store();
    let mut r = req("run-1", "node-a", 1, 1, "报告", "out/a.md", b"x", "idem-bad");
    r.run_id = String::new();
    let err = store.put(r).unwrap_err();
    assert!(matches!(err, ArtifactError::Invalid(_)), "实际：{err:?}");

    let mut r = req("run-1", "node-a", 1, 1, "报告", "out/a.md", b"x", "");
    r.idempotency_key = String::new();
    assert!(matches!(store.put(r), Err(ArtifactError::Invalid(_))));

    assert!(store.list("run-1", None, None, None).unwrap().is_empty());
}

/// SPEC「内容写入与归属记录」：在内容落盘与元数据提交边界注入故障
/// （fail_after_content），重开存储后可见记录均对应完整可读取内容。
#[test]
fn 边界故障注入后重开存储可见记录均完整可读() {
    let (store, db_path, content_root) = open_store();
    let ok = store
        .put(req("run-f", "node-a", 1, 1, "完好", "out/ok.md", b"ok", "idem-ok"))
        .unwrap();

    let err = store
        .put_with_failpoint(
            req("run-f", "node-a", 1, 2, "半成品", "out/half.md", b"half", "idem-half"),
            true,
        )
        .unwrap_err();
    assert!(matches!(err, ArtifactError::Failpoint(_)));

    // 故障后（重开前）：失败产物不可见，原完好记录可读。
    let listed = store.list("run-f", None, None, None).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].artifact_id, ok.artifact_id);

    // 重开存储：可见记录均完整可读（元数据与内容一致）。
    let reopened = reopen(&db_path, &content_root);
    for record in reopened.list("run-f", None, None, None).unwrap() {
        let obj = reopened.get(&record.artifact_id).unwrap();
        assert_eq!(obj.bytes, b"ok");
        assert_eq!(obj.record.artifact_id, ok.artifact_id);
    }
    assert!(reopened.get_meta(&ok.artifact_id).is_ok());
}

/// SPEC「内容写入与归属记录」（联测边界场景）：故障遗留的孤儿内容可被
/// sweep 清理；已提交引用的内容保持不受影响。
#[test]
fn 故障遗留孤儿内容可清理且引用内容保留() {
    let (store, _db, _root) = open_store();
    let kept = store
        .put(req("run-s", "node-a", 1, 1, "保留", "out/keep.md", b"keep", "idem-keep"))
        .unwrap();
    let _ = store
        .put_with_failpoint(
            req("run-s", "node-a", 1, 2, "孤儿", "out/orphan.md", b"orphan-bytes", "idem-orphan"),
            true,
        )
        .unwrap_err();

    // 孤儿内容 id = sha256("orphan-bytes")，故障注入返回值中带出。
    let orphan_id = {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(b"orphan-bytes"))
    };

    // 以 0 宽限（older_than = ZERO）模拟「已过保护期」：引用内容保留，
    // 故障遗留的孤儿被删；这正是「失败不产生可见半成品，孤儿可 sweep」
    // 的联测边界场景。
    let removed = store.sweep_orphans(Duration::ZERO).unwrap();
    assert!(removed.contains(&orphan_id), "孤儿应被清理：{removed:?}");
    // 已引用内容必须仍可读（本域核心语义）。
    let obj = store.get(&kept.artifact_id).unwrap();
    assert_eq!(obj.bytes, b"keep");

    // 失败产物没有元数据记录：列举不可见。
    assert!(store.list("run-s", None, None, Some(2)).unwrap().is_empty());
}

// ======== 第 2 组：稳定读取与范围列举 ========

/// SPEC「稳定读取与范围列举」：关闭并重新打开临时 SQLite 与内容目录后，
/// 原标识读取的内容和校验信息保持一致。
#[test]
fn 重开存储后原标识内容与校验信息一致() {
    let (store, db_path, content_root) = open_store();
    let a = store
        .put(req("run-r", "node-a", 1, 1, "文档", "out/a.md", "内容A".as_bytes(), "idem-ra"))
        .unwrap();
    let b = store
        .put(req("run-r", "node-a", 1, 2, "文档", "out/b.md", "内容B".as_bytes(), "idem-rb"))
        .unwrap();

    let reopened = reopen(&db_path, &content_root);
    let oa = reopened.get(&a.artifact_id).unwrap();
    assert_eq!(oa.bytes, "内容A".as_bytes());
    assert_eq!(oa.record.sha256, a.sha256);
    assert_eq!(oa.record.size, a.size);
    assert_eq!(oa.record.content_id, a.content_id);
    let ob = reopened.get(&b.artifact_id).unwrap();
    assert_eq!(ob.bytes, "内容B".as_bytes());
    assert_eq!(reopened.get_meta(&b.artifact_id).unwrap(), b);
}

/// SPEC「稳定读取与范围列举」：为多个运行、节点、代数和尝试写入同名文件，
/// 按范围查询仅返回匹配记录。
#[test]
fn 多维度写入后按范围查询仅返回匹配记录() {
    let (store, _db, _root) = open_store();
    for run in ["run-1", "run-2"] {
        for node in ["node-a", "node-b"] {
            for generation_value in [1u64, 2] {
                for att in [1u64, 2] {
                    let key = format!("{run}-{node}-{generation_value}-{att}");
                    store
                        .put(req(
                            run, node, generation_value, att, "同名", "out/same.md",
                            key.as_bytes(), &format!("idem-{key}"),
                        ))
                        .unwrap();
                }
            }
        }
    }

    let all = store.list("run-1", None, None, None).unwrap();
    assert_eq!(all.len(), 8);
    assert!(store
        .list("run-1", Some("node-a"), None, None)
        .unwrap()
        .iter()
        .all(|r| r.node_id == "node-a"));
    assert_eq!(store.list("run-1", Some("node-a"), None, None).unwrap().len(), 4);
    assert_eq!(store.list("run-1", Some("node-a"), Some(2), None).unwrap().len(), 2);
    let exact = store.list("run-1", Some("node-b"), Some(1), Some(2)).unwrap();
    assert_eq!(exact.len(), 1);
    assert_eq!(exact[0].node_id, "node-b");
    assert_eq!(exact[0].generation, 1);
    assert_eq!(exact[0].attempt, 2);
    assert_eq!(exact[0].idempotency_key, "idem-run-1-node-b-1-2");
    assert!(store.list("run-不存在", None, None, None).unwrap().is_empty());
}

/// SPEC「稳定读取与范围列举」：新产物写入后旧标识继续读取旧内容，
/// 缺失标识或损坏内容返回可识别错误。
#[test]
fn 新写入后旧标识仍可读且缺失损坏可识别() {
    let (store, _db, content_root) = open_store();
    let old = store
        .put(req("run-c", "node-a", 1, 1, "旧产物", "out/old.md", "旧内容".as_bytes(), "idem-c1"))
        .unwrap();
    let new = store
        .put(req("run-c", "node-a", 1, 2, "新产物", "out/new.md", "新内容".as_bytes(), "idem-c2"))
        .unwrap();

    // 内容寻址隔离：旧标识继续读旧内容。
    assert_eq!(store.get(&old.artifact_id).unwrap().bytes, "旧内容".as_bytes());
    assert_eq!(store.get(&new.artifact_id).unwrap().bytes, "新内容".as_bytes());

    // 缺失标识：可识别 NotFound。
    assert!(matches!(
        store.get("不存在标识"),
        Err(ArtifactError::NotFound(_))
    ));
    assert!(matches!(
        store.get_meta("不存在标识"),
        Err(ArtifactError::NotFound(_))
    ));

    // 损坏内容：读取返回可识别的内容错误（错误不含根目录外路径）。
    let content_id = old.content_id.clone();
    let cs = ContentStore::open(&content_root).unwrap();
    let obj_path = cs.test_object_path(&content_id);
    std::fs::write(&obj_path, "篡改后的字节".as_bytes()).unwrap();
    let err = store.get(&old.artifact_id).unwrap_err();
    assert!(matches!(err, ArtifactError::Content(_)), "实际：{err:?}");
    let msg = err.to_string();
    assert!(msg.contains(&old.artifact_id), "错误须定位产物：{msg}");
    assert!(!msg.contains(content_root.to_str().unwrap()), "错误不得泄漏根路径：{msg}");
}

// ======== 第 3 组：重试幂等与冲突识别 ========

/// SPEC「重试幂等与冲突识别」：同一请求串行重试后仅一条记录，返回同一
/// 产物标识与内容。
#[test]
fn 串行重试收敛为一条记录且复用原标识() {
    let (store, _db, _root) = open_store();
    let bytes = "稳定内容".as_bytes().to_vec();
    let first = store
        .put(req("run-p", "node-a", 1, 1, "产物", "out/p.md", &bytes, "idem-p"))
        .unwrap();
    for _ in 0..3 {
        let retried = store
            .put(req("run-p", "node-a", 1, 1, "产物", "out/p.md", &bytes, "idem-p"))
            .unwrap();
        assert_eq!(retried.artifact_id, first.artifact_id);
        assert_eq!(retried.created_at, first.created_at);
    }
    let listed = store.list("run-p", None, None, None).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(store.get(&first.artifact_id).unwrap().bytes, bytes);
}

/// SPEC「重试幂等与冲突识别」：并发重试（tokio join）后仅一条记录，
/// 并发返回一致。
#[tokio::test(flavor = "multi_thread")]
async fn 并发重试收敛为一条记录() {
    let (store, _db, _root) = open_store();
    let store = std::sync::Arc::new(store);
    let bytes = "并发内容".as_bytes().to_vec();

    let mut handles = Vec::new();
    for _ in 0..6 {
        let store = store.clone();
        let bytes = bytes.clone();
        handles.push(tokio::task::spawn_blocking(move || {
            store.put(req("run-q", "node-a", 1, 1, "产物", "out/q.md", &bytes, "idem-q"))
        }));
    }
    let results = futures_util::future::join_all(handles).await;
    let mut ids = std::collections::HashSet::new();
    for r in results {
        let record = r.unwrap().unwrap();
        ids.insert(record.artifact_id);
        assert_eq!(record.name, "产物");
    }
    assert_eq!(ids.len(), 1, "并发重试必须收敛为同一 artifact_id");
    let listed = store.list("run-q", None, None, None).unwrap();
    assert_eq!(listed.len(), 1);
}

/// SPEC「重试幂等与冲突识别」：同一幂等标识提交不同字节时返回冲突，
/// 原内容与元数据保持不变。
#[test]
fn 同幂等键不同内容返回冲突且原记录不变() {
    let (store, _db, _root) = open_store();
    let first = store
        .put(req("run-x", "node-a", 1, 1, "产物", "out/x.md", "原始内容".as_bytes(), "idem-x"))
        .unwrap();

    let err = store
        .put(req("run-x", "node-a", 1, 1, "产物", "out/x.md", "不同内容".as_bytes(), "idem-x"))
        .unwrap_err();
    assert!(matches!(err, ArtifactError::Conflict(_)), "实际：{err:?}");

    // 元数据不变：仍指向原内容，列举仍只有一条。
    let got = store.get(&first.artifact_id).unwrap();
    assert_eq!(got.bytes, "原始内容".as_bytes());
    assert_eq!(store.list("run-x", None, None, None).unwrap().len(), 1);
}

/// SPEC「重试幂等与冲突识别」：同一幂等键更换关键元数据（node/attempt/
/// generation/name/path）时返回冲突（任务指定「任一不同即 Conflict」）。
#[test]
fn 同幂等键关键元数据不同返回冲突() {
    let (store, _db, _root) = open_store();
    let first = store
        .put(req("run-y", "node-a", 1, 1, "产物", "out/y.md", "内容".as_bytes(), "idem-y"))
        .unwrap();

    // node 不同。
    let mut r = req("run-y", "node-a", 1, 1, "产物", "out/y.md", "内容".as_bytes(), "idem-y");
    r.node_id = "node-z".to_string();
    assert!(matches!(store.put(r), Err(ArtifactError::Conflict(_))));
    // attempt 不同。
    let mut r = req("run-y", "node-a", 1, 1, "产物", "out/y.md", "内容".as_bytes(), "idem-y");
    r.attempt = 2;
    assert!(matches!(store.put(r), Err(ArtifactError::Conflict(_))));
    // generation 不同。
    let mut r = req("run-y", "node-a", 1, 1, "产物", "out/y.md", "内容".as_bytes(), "idem-y");
    r.generation = 2;
    assert!(matches!(store.put(r), Err(ArtifactError::Conflict(_))));
    // name 不同。
    let mut r = req("run-y", "node-a", 1, 1, "产物", "out/y.md", "内容".as_bytes(), "idem-y");
    r.name = "其他产物".to_string();
    assert!(matches!(store.put(r), Err(ArtifactError::Conflict(_))));
    // path 不同。
    let mut r = req("run-y", "node-a", 1, 1, "产物", "out/y.md", "内容".as_bytes(), "idem-y");
    r.path = "out/other.md".to_string();
    assert!(matches!(store.put(r), Err(ArtifactError::Conflict(_))));
    // media_type 不同。
    let mut r = req("run-y", "node-a", 1, 1, "产物", "out/y.md", "内容".as_bytes(), "idem-y");
    r.media_type = Some("application/pdf".to_string());
    assert!(matches!(store.put(r), Err(ArtifactError::Conflict(_))));
    // required 不同。
    let mut r = req("run-y", "node-a", 1, 1, "产物", "out/y.md", "内容".as_bytes(), "idem-y");
    r.required = false;
    assert!(matches!(store.put(r), Err(ArtifactError::Conflict(_))));

    // 冲突信息可定位既有产物与不一致字段。
    let err = store
        .put(req("run-y", "node-a", 1, 1, "产物", "out/y.md", "改内容".as_bytes(), "idem-y"))
        .unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains(&first.artifact_id) && msg.contains("内容"), "{msg}");
}

/// SPEC「重试幂等与冲突识别」：相同节点在不同 attempt 或 generation 提交
/// 同名产物，能够分别列举和读取。
#[test]
fn 不同attempt与generation同名产物独立可列举可读取() {
    let (store, _db, _root) = open_store();
    let a1 = store
        .put(req("run-z", "node-a", 1, 1, "同名", "out/same.md", "第一轮".as_bytes(), "idem-z-a1"))
        .unwrap();
    let a2 = store
        .put(req("run-z", "node-a", 1, 2, "同名", "out/same.md", "第二轮".as_bytes(), "idem-z-a2"))
        .unwrap();
    let g2 = store
        .put(req("run-z", "node-a", 2, 1, "同名", "out/same.md", "二代".as_bytes(), "idem-z-g2"))
        .unwrap();
    assert_ne!(a1.artifact_id, a2.artifact_id);
    assert_ne!(a1.artifact_id, g2.artifact_id);

    assert_eq!(store.get(&a1.artifact_id).unwrap().bytes, "第一轮".as_bytes());
    assert_eq!(store.get(&a2.artifact_id).unwrap().bytes, "第二轮".as_bytes());
    assert_eq!(store.get(&g2.artifact_id).unwrap().bytes, "二代".as_bytes());

    assert_eq!(store.list("run-z", Some("node-a"), Some(1), Some(1)).unwrap().len(), 1);
    assert_eq!(store.list("run-z", Some("node-a"), Some(1), Some(2)).unwrap().len(), 1);
    assert_eq!(store.list("run-z", Some("node-a"), Some(2), None).unwrap().len(), 1);
    assert_eq!(store.list("run-z", None, None, None).unwrap().len(), 3);
}

// ======== 第 4 组：路径安全与内容交付 ========

/// SPEC「路径安全与内容交付」：合法嵌套相对路径可保存与读取，返回稳定
/// 内容标识；绝对路径、目录穿越被拒（元数据层校验）。
#[test]
fn 合法嵌套路径可读写且危险路径被拒() {
    let (store, _db, _root) = open_store();
    let record = store
        .put(req("run-s1", "node-a", 1, 1, "深产物", "a/b/c/深/目录/文件.md", "嵌套".as_bytes(), "idem-s1"))
        .unwrap();
    assert_eq!(store.get(&record.artifact_id).unwrap().bytes, "嵌套".as_bytes());
    assert_eq!(record.content_id.len(), 64);

    for bad in ["/etc/passwd", "../escape.md", "out/../../escape.md", "..", "./rel.md", ""] {
        let err = store
            .put(req("run-s1", "node-a", 1, 1, "越界", bad, b"x", format!("idem-bad-{bad}").as_str()))
            .unwrap_err();
        assert!(matches!(err, ArtifactError::Invalid(_)), "路径 {bad:?} 应被拒：{err:?}");
        assert!(store.list("run-s1", None, None, None).unwrap().len() == 1, "路径 {bad:?} 失败不得产生记录");
    }

    // 根目录外文件保持原样：不存在的目标不被创建。
    let escaped = std::path::Path::new(&_root).parent().unwrap().join("escape.md");
    assert!(!escaped.exists());
}

/// SPEC「路径安全与内容交付」：指向根目录外的符号链接被拒，根目录外
/// 文件保持原样（集成测试：经 ArtifactStore 写入触发文件系统层校验）。
#[test]
fn 符号链接逃逸路径经存储写入被拒且根外文件保持原样() {
    let (store, _db, content_root) = open_store();
    let root = content_root.clone();
    let outside = std::path::Path::new(&root).parent().unwrap().join("outside-secret.txt");
    std::fs::write(&outside, "机密".as_bytes()).unwrap();

    // 根目录内预置 symlink：out -> 根目录外目录。
    let out_dir = std::path::Path::new(&root).join("out");
    std::fs::create_dir(outside.parent().unwrap().join("outside-dir")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.parent().unwrap().join("outside-dir"), &out_dir).unwrap();

    // 经 ArtifactStore 写入含 symlink 组件的路径：内容存储层拒绝。
    let err = store
        .put(req("run-sl", "node-a", 1, 1, "逃逸", "out/leak.md", "逃逸内容".as_bytes(), "idem-sl"))
        .unwrap_err();
    assert!(
        matches!(err, ArtifactError::Invalid(_)),
        "symlink 逃逸应被拒：{err:?}"
    );

    // 根目录外文件保持原样，未被写入逃逸内容。
    assert_eq!(std::fs::read(&outside).unwrap(), "机密".as_bytes());
    // 元数据无记录。
    assert!(store.list("run-sl", None, None, None).unwrap().is_empty());
    // 清理 symlink 便于临时目录删除。
    let _ = std::fs::remove_file(&out_dir);
    let _ = std::fs::remove_file(&outside);
    let _ = std::fs::remove_dir(outside.parent().unwrap().join("outside-dir"));
}

// ======== 第 5 组：产物契约检查 ========

/// SPEC「产物契约检查」：提交满足声明的产物集合，检查通过并定位每个
/// 匹配的产物标识；检查前后存储状态不变（纯函数）。
#[test]
fn 契约检查通过并定位匹配产物标识() {
    let (store, _db, _root) = open_store();
    let r1 = store
        .put(req("run-ct", "node-a", 1, 1, "报告", "out/report.md", "# 报告".as_bytes(), "idem-ct1"))
        .unwrap();
    let r2 = store
        .put(req("run-ct", "node-a", 1, 1, "附加", "out/extra.log", b"log", "idem-ct2"))
        .unwrap();
    let listed = store.list("run-ct", None, None, None).unwrap();

    let declared = vec![
        contract("报告", "out/report.md", true, Some("text/markdown")),
        contract("附加", "out/extra.log", false, Some("text/plain")),
    ];
    let report = check_contract(&declared, &listed);
    assert!(report.all_passed);
    assert_eq!(
        report.items,
        vec![
            ContractCheck::Pass { artifact_id: Some(r1.artifact_id.clone()) },
            ContractCheck::Pass { artifact_id: Some(r2.artifact_id.clone()) },
        ]
    );

    // 纯函数：重复检查结果一致，存储不变。
    let again = check_contract(&declared, &listed);
    assert_eq!(report, again);
    assert_eq!(store.list("run-ct", None, None, None).unwrap().len(), 2);
}

/// SPEC「产物契约检查」：缺失必需文件或内容类型不匹配时，返回对应契约
/// 项的失败结果；非必需缺失不失败。
#[test]
fn 契约检查缺失与类型不匹配逐项失败() {
    let (store, _db, _root) = open_store();
    let _ = store
        .put(req("run-ce", "node-a", 1, 1, "报告", "out/report.md", b"x", "idem-ce1"))
        .unwrap();
    let listed = store.list("run-ce", None, None, None).unwrap();

    let declared = vec![
        contract("报告", "out/report.md", true, Some("text/markdown")),
        contract("附录", "out/appendix.md", true, None),
        contract("可选", "out/optional.md", false, None),
    ];
    let report = check_contract(&declared, &listed);
    assert!(!report.all_passed);
    assert_eq!(report.items.len(), 3);
    // 类型不匹配：声明 text/markdown，实际 application/pdf……本例报告实际为
    // text/markdown，因此第 1 项应通过；缺失为第 2 项。
    assert!(matches!(&report.items[0], ContractCheck::Pass { .. }));
    assert!(matches!(&report.items[1], ContractCheck::Fail { reason } if reason.contains("附录") && reason.contains("out/appendix.md")));
    assert!(matches!(&report.items[2], ContractCheck::Pass { .. }));

    // 类型不匹配场景：声明 pdf，实际 markdown。
    let declared_pdf = vec![contract("报告", "out/report.md", true, Some("application/pdf"))];
    let report_pdf = check_contract(&declared_pdf, &listed);
    assert!(!report_pdf.all_passed);
    assert!(matches!(
        &report_pdf.items[0],
        ContractCheck::Fail { reason } if reason.contains("text/markdown") && reason.contains("application/pdf")
    ));
}

/// SPEC「产物契约检查」：检查通过或失败均不写入任何状态（显式验证：
/// 通过/失败调用后存储可见状态与调用前一致）。
#[test]
fn 契约检查不改变存储状态() {
    let (store, _db, _root) = open_store();
    let record = store
        .put(req("run-cn", "node-a", 1, 1, "报告", "out/report.md", b"r", "idem-cn"))
        .unwrap();
    let listed_before = store.list("run-cn", None, None, None).unwrap();

    let pass_decl = vec![contract("报告", "out/report.md", true, Some("text/markdown"))];
    assert!(check_contract(&pass_decl, &listed_before).all_passed);
    let fail_decl = vec![contract("缺失项", "out/none.md", true, None)];
    assert!(!check_contract(&fail_decl, &listed_before).all_passed);

    let listed_after = store.list("run-cn", None, None, None).unwrap();
    assert_eq!(listed_before, listed_after);
    assert_eq!(listed_after.len(), 1);
    assert_eq!(listed_after[0].artifact_id, record.artifact_id);
}

// ======== 清理（sweep_orphans）========

/// SPEC「清理」：sweep_orphans 以元数据引用为准，已引用内容保持可读；
/// 未引用旧内容被删除。
#[test]
fn 清理保留引用内容并删除未引用旧内容() {
    let (store, _db, content_root) = open_store();
    let referenced = store
        .put(req("run-sw", "node-a", 1, 1, "引用", "out/ref.md", "被引用内容".as_bytes(), "idem-sw1"))
        .unwrap();

    // 直接向内容存储塞一个未引用对象（模拟故障遗留孤儿）。
    // older_than 取 ZERO：保护窗口归零，除引用保护外全部对象均越过清理线。
    let cs = ContentStore::open(&content_root).unwrap();
    let orphan_id = cs.write("orphan/orphan.md", "孤儿内容".as_bytes()).unwrap();

    let removed = store.sweep_orphans(Duration::ZERO).unwrap();
    assert_eq!(removed, vec![orphan_id]);
    // 已引用内容保持可读。
    let obj = store.get(&referenced.artifact_id).unwrap();
    assert_eq!(obj.bytes, "被引用内容".as_bytes());
}

/// SPEC「清理」：时间保护窗口内的未引用内容（刚写入、引用未提交）不被
/// 清理，避免误删在途写入。
#[test]
fn 清理不触碰保护窗口内的在途内容() {
    let (store, _db, content_root) = open_store();
    let referenced = store
        .put(req("run-sw2", "node-a", 1, 1, "引用", "out/ref.md", "引用内容".as_bytes(), "idem-sw2"))
        .unwrap();
    let cs = ContentStore::open(&content_root).unwrap();
    let fresh_orphan = cs.write("fresh/fresh.md", "在途内容".as_bytes()).unwrap();

    let removed = store.sweep_orphans(Duration::from_secs(3600)).unwrap();
    assert!(removed.is_empty());
    assert!(store.get(&referenced.artifact_id).is_ok());
    // 在途内容对象仍在盘上。
    assert!(cs.test_object_path(&fresh_orphan).exists());
}

