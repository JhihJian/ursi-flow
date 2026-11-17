//! storage 单元与验收测试，每个测试名对应 SPEC 验收语义。

use std::io::Write as _;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use rusqlite::params;
use sha2::Digest;

use super::{Database, Migration, MigrationError};
use crate::storage::{ContentError, ContentStore, StoreError};

// ---- 数据库打开与迁移 ----

/// SPEC：使用空临时目录打开数据库，完成建表后可供 repository 读写。
#[test]
fn migration_creates_tables_and_repository_can_read_write() {
    let migrations = &[
        Migration::new(
            "create_items",
            "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        ),
    ];
    let dir = tempfile::tempdir().expect("创建临时目录");
    let db = Database::open(dir.path().join("ursi.db"), migrations).expect("打开数据库");

    db.with_conn(|conn| {
        conn.execute("INSERT INTO items (name) VALUES (?1)", params!["alpha"])?;
        Ok(())
    })
    .expect("写入");
    let name: String = db
        .with_conn(|conn| conn.query_row("SELECT name FROM items WHERE id = 1", [], |r| r.get(0)))
        .expect("读出");
    assert_eq!(name, "alpha");

    // 连接配置：WAL 日志模式与 busy_timeout 均已生效。
    let mode: String = db
        .with_conn(|conn| conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)))
        .expect("journal_mode");
    assert_eq!(mode.to_lowercase(), "wal", "应处于 WAL 模式");
    let timeout_ms: i64 = db
        .with_conn(|conn| conn.query_row("PRAGMA busy_timeout", [], |r| r.get(0)))
        .expect("busy_timeout");
    assert_eq!(timeout_ms, 5000, "busy_timeout 应为 5 秒");
}

/// SPEC：重复打开不重复执行已完成迁移（以副作用计数证明只跑一次）。
#[test]
fn reopening_database_skips_completed_migrations() {
    let migrations = &[
        Migration::new(
            "seed",
            "CREATE TABLE events (name TEXT); INSERT INTO events (name) VALUES ('seed');",
        ),
    ];
    let dir = tempfile::tempdir().expect("创建临时目录");
    let path = dir.path().join("ursi.db");

    Database::open(&path, migrations).expect("首开");
    Database::open(&path, migrations).expect("重开");
    let db = Database::open(&path, migrations).expect("三开后检查");

    let count: i64 = db
        .with_conn(|conn| conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)))
        .expect("计数");
    assert_eq!(count, 1, "重开后种子行不应重复插入");
}

/// SPEC：关闭连接后重新打开，已提交数据和迁移记录保留。
#[test]
fn data_and_version_survive_reopen() {
    let migrations = &[Migration::new(
        "create_kv",
        "CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
    )];
    let dir = tempfile::tempdir().expect("创建临时目录");
    let path = dir.path().join("ursi.db");

    {
        let db = Database::open(&path, migrations).expect("首次打开");
        db.with_conn(|conn| conn.execute("INSERT INTO kv VALUES ('k', 'v1')", []))
            .expect("写入");
    } // Database dropped，连接关闭。

    let db = Database::open(&path, migrations).expect("重开");
    let v: String = db
        .with_conn(|conn| conn.query_row("SELECT v FROM kv WHERE k = 'k'", [], |r| r.get(0)))
        .expect("读出");
    assert_eq!(v, "v1");
    let version: i64 = db
        .with_conn(|conn| conn.query_row("PRAGMA user_version", [], |r| r.get(0)))
        .expect("读版本");
    assert_eq!(version, 1, "迁移版本应保留");
}

/// SPEC：注入迁移失败，返回明确错误；失败迁移不被记录为成功，版本不前进。
#[test]
fn failed_migration_returns_error_and_does_not_advance_version() {
    let migrations = &[
        Migration::new("ok_step", "CREATE TABLE good (id INTEGER);"),
        Migration::new("bad_step", "THIS IS NOT VALID SQL;"),
    ];
    let dir = tempfile::tempdir().expect("创建临时目录");
    let path = dir.path().join("ursi.db");

    let err = Database::open(&path, migrations).expect_err("应迁移失败");
    let MigrationError::Failed { migration, .. } = err else {
        panic!("应返回 Failed，实际：{err:?}");
    };
    assert_eq!(migration, "bad_step");

    // 版本停在 1，修复列表后（去掉坏迁移）重开仍能看到第一条迁移的表。
    let db = Database::open(&path, &[Migration::new("ok_step", "CREATE TABLE good (id INTEGER);")])
        .expect("重开");
    let version: i64 = db
        .with_conn(|conn| conn.query_row("PRAGMA user_version", [], |r| r.get(0)))
        .expect("读版本");
    assert_eq!(version, 1, "失败迁移的版本不应前进");
    let good: i64 = db
        .with_conn(|conn| conn.query_row("SELECT COUNT(*) FROM good", [], |r| r.get(0)))
        .expect("查询");
    let _ = good;
}

/// 迁移列表被回退时拒绝打开（版本一致性防御）。
#[test]
fn shrinking_migration_list_is_rejected() {
    let two = &[
        Migration::new("m1", "CREATE TABLE a (id INTEGER);"),
        Migration::new("m2", "CREATE TABLE b (id INTEGER);"),
    ];
    let dir = tempfile::tempdir().expect("创建临时目录");
    let path = dir.path().join("ursi.db");
    Database::open(&path, two).expect("首次打开");

    let one = &[Migration::new("m1", "CREATE TABLE a (id INTEGER);")];
    let err = Database::open(&path, one).expect_err("应拒绝回退列表");
    assert!(matches!(err, MigrationError::VersionMismatch { .. }), "实际：{err:?}");
}

// ---- 事务上下文 ----

/// SPEC：同一事务写两个表，中途失败后均不可见；成功提交后均可见。
#[test]
fn transaction_spans_two_tables_commit_and_rollback() {
    let migrations = &[
        Migration::new("t1", "CREATE TABLE t1 (v TEXT UNIQUE);"),
        Migration::new("t2", "CREATE TABLE t2 (v TEXT);"),
    ];
    let dir = tempfile::tempdir().expect("创建临时目录");
    let db = Database::open(dir.path().join("ursi.db"), migrations).expect("打开");

    // 提交路径：两表均可见。
    {
        let mut tx = db.begin().expect("开启事务");
        let conn = tx.conn();
        conn.execute("INSERT INTO t1 VALUES ('a')", []).expect("写 t1");
        conn.execute("INSERT INTO t2 VALUES ('b')", []).expect("写 t2");
        tx.commit().expect("提交");
    }
    let (c1, c2) = count_two_tables(&db);
    assert_eq!((c1, c2), (1, 1), "提交后两表均可见");

    // 回滚路径：中途失败（重复主键），两表均不可见。
    let result = (|| -> Result<(), StoreError> {
        let mut tx = db.begin()?;
        let conn = tx.conn();
        conn.execute("INSERT INTO t1 VALUES ('x')", []).map_err(StoreError::from)?;
        conn.execute("INSERT INTO t2 VALUES ('x')", []).map_err(StoreError::from)?;
        // 模拟中途失败：t1 已有 'a'，再插入触发唯一约束。
        conn.execute("INSERT INTO t1 VALUES ('a')", [])
            .map_err(StoreError::from)?;
        tx.commit()
    })();
    assert!(result.is_err(), "中途失败应返回错误");
    let (c1, c2) = count_two_tables(&db);
    assert_eq!((c1, c2), (1, 1), "失败事务的两表写入均不可见");
}

/// SPEC：事务内多次查询使用同一一致性视图，并发提交不产生新旧混合读取。
#[test]
fn transaction_reads_consistent_snapshot_across_queries() {
    let migrations = &[
        Migration::new("cfg", "CREATE TABLE cfg (k TEXT PRIMARY KEY, v TEXT);"),
    ];
    let dir = tempfile::tempdir().expect("创建临时目录");
    let db = Arc::new(Database::open(dir.path().join("ursi.db"), migrations).expect("打开"));

    db.with_conn(|conn| conn.execute("INSERT INTO cfg VALUES ('flag', 'old')", []))
        .expect("初始化");

    // 事务开读前记录：SQLite 默认隔离下，读事务内首次查询后外部提交的新值不可见。
    let handle = {
        let db = db.clone();
        thread::spawn(move || {
            let mut tx = db.begin().expect("开启读事务");
            let first: String = tx
                .conn()
                .query_row("SELECT v FROM cfg WHERE k = 'flag'", [], |r| r.get(0))
                .expect("首次查询");
            // 等外部并发提交新值后再查第二次。
            thread::sleep(Duration::from_millis(200));
            let second: String = tx
                .conn()
                .query_row("SELECT v FROM cfg WHERE k = 'flag'", [], |r| r.get(0))
                .expect("二次查询");
            tx.commit().expect("提交");
            (first, second)
        })
    };
    // 事务已持 IMMEDIATE 写锁开始；另一连接的并发提交在 busy_timeout 内等待。
    thread::sleep(Duration::from_millis(50));
    {
        let other = Database::open(db.path(), migrations).expect("第二个连接");
        other
            .with_conn(|conn| conn.execute("UPDATE cfg SET v = 'new' WHERE k = 'flag'", []))
            .expect("并发更新提交");
    }
    let (first, second) = handle.join().expect("事务线程");
    assert_eq!(first, "old", "首次读到旧值");
    assert_eq!(second, "old", "同一事务内两次查询视图一致，无新旧混合");
}

/// SPEC：两个真实连接冲突写入同一行，等待或返回可处理错误，不静默丢失更新。
#[test]
fn conflicting_writers_serialize_or_return_busy_error() {
    static MIGRATIONS: &[Migration] = &[Migration::new(
        "ctr",
        "CREATE TABLE ctr (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);",
    )];
    let dir = tempfile::tempdir().expect("创建临时目录");
    let path = dir.path().join("ursi.db");
    let db = Database::open(&path, MIGRATIONS).expect("打开");
    db.with_conn(|conn| conn.execute("INSERT INTO ctr VALUES (1, 0)", []))
        .expect("初始化");

    let mut handles = Vec::new();
    for _ in 0..2 {
        // 每个线程各自打开真实连接，模拟两个独立写入方。
        let path = path.clone();
        handles.push(thread::spawn(move || {
            let db = Database::open(&path, MIGRATIONS).expect("打开独立连接");
            let mut tx = db.begin().expect("开启事务");
            tx.conn()
                .execute("UPDATE ctr SET n = n + 1 WHERE id = 1", [])
                .expect("自增");
            tx.commit().expect("提交");
        }));
    }
    for h in handles {
        h.join().expect("写线程不应失败");
    }
    let n: i64 = db
        .with_conn(|conn| conn.query_row("SELECT n FROM ctr WHERE id = 1", [], |r| r.get(0)))
        .expect("读结果");
    assert_eq!(n, 2, "两个事务的更新都应生效（串行化，无静默丢失）");
}

/// SPEC：事务作用域退出且未提交时回滚，连接可继续用于后续操作。
#[test]
fn dropping_uncommitted_transaction_rolls_back_and_connection_usable() {
    let migrations = &[
        Migration::new("t", "CREATE TABLE t (v TEXT);"),
    ];
    let dir = tempfile::tempdir().expect("创建临时目录");
    let db = Database::open(dir.path().join("ursi.db"), migrations).expect("打开");

    {
        let mut tx = db.begin().expect("开启事务");
        tx.conn()
            .execute("INSERT INTO t VALUES ('never')", [])
            .expect("写入");
        // 不提交，直接退出作用域（drop 触发 guard 回滚）。
    }
    let count: i64 = db
        .with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
        })
        .expect("连接仍可用");
    assert_eq!(count, 0, "未提交事务应已回滚");
}

// ---- 稳定内容存储 ----

/// SPEC：写入内容并重开存储后，按标识读取的字节一致。
#[test]
fn content_roundtrip_after_reopening_store() {
    let dir = tempfile::tempdir().expect("创建临时目录");
    let root = dir.path().join("content");
    let id = {
        let store = ContentStore::open(&root).expect("打开存储");
        store.write("blobs/a.bin", b"payload-1").expect("写入")
    };
    let store = ContentStore::open(&root).expect("重开存储");
    let bytes = store.read(&id).expect("读出");
    assert_eq!(bytes, b"payload-1");
}

/// SPEC：写入中断不会将半份内容发布为可用对象。
#[test]
fn interrupted_write_publishes_no_partial_content() {
    let dir = tempfile::tempdir().expect("创建临时目录");
    let store = ContentStore::open(dir.path().join("content")).expect("打开存储");

    // 错误注入模拟写入中断：临时文件已建、只写了半份，且未发布（无 rename）。
    let bytes = b"intended-bytes";
    let mut hasher = sha2::Sha256::new();
    hasher.update(bytes);
    let id = hex::encode(hasher.finalize());
    let final_path = store.test_object_path(&id);
    let parent = final_path.parent().expect("分片目录");
    std::fs::create_dir_all(parent).expect("建分片目录");
    let tmp_path = parent.join(".interrupted.tmp");
    let mut tmp = std::fs::File::create(&tmp_path).expect("建临时文件");
    tmp.write_all(&bytes[..4]).expect("写半份");
    tmp.flush().expect("flush");
    drop(tmp);

    assert!(!final_path.exists(), "未发布前不应有对象");
    assert!(store.read(&id).is_err(), "半份内容不可读");

    // 正式写入成功后对象可用且完整；遗留临时文件随后被 sweep 清理。
    let id2 = store.write("x/y", bytes).expect("写入");
    assert_eq!(id, id2);
    assert_eq!(store.read(&id).expect("读出"), bytes);
    assert!(tmp_path.exists(), "sweep 前遗留临时文件仍在");
    store
        .sweep_unreferenced(&[id.clone()], Duration::from_secs(0))
        .expect("清理");
    assert!(!tmp_path.exists(), "遗留临时文件应被清理");
    assert!(store.read(&id).is_ok(), "keep 列表内对象不受 sweep 影响");
}

/// SPEC：路径穿越、绝对路径或符号链接逃逸请求被拒绝，存储目录外文件保持不变。
#[test]
fn path_escape_attempts_are_rejected_and_outside_files_untouched() {
    let dir = tempfile::tempdir().expect("创建临时目录");
    let root = dir.path().join("content");
    let outside = dir.path().join("outside.txt");
    std::fs::write(&outside, b"outside").expect("写外部文件");

    let store = ContentStore::open(&root).expect("打开存储");
    store.write("keep/me.txt", b"kept").expect("写入合法内容");

    // symlink 逃逸准备：先建目录再让组件指向外部文件。
    let link_dir = root.join("link");
    std::fs::create_dir(&link_dir).expect("建目录");
    std::os::unix::fs::symlink(&outside, link_dir.join("out.txt")).expect("建 symlink");

    let escapes = [
        "../outside.txt",
        "a/../../outside.txt",
        "/etc/passwd",
        "link/out.txt", // link/out.txt 是指向外部的 symlink。
    ];
    for case in escapes {
        let err = store
            .write(case, b"escaped")
            .expect_err(&format!("应拒绝 {case}"));
        let ContentError::InvalidPath(_) = err else {
            panic!("{case} 应报 InvalidPath，实际：{err:?}");
        };
    }
    // 错误信息不泄漏外部路径。
    let err = store
        .write("link/out.txt", b"escaped")
        .expect_err("symlink 逃逸应被拒绝");
    let msg = err.to_string();
    assert!(!msg.contains("outside"), "错误信息不应泄漏外部路径：{msg}");
    assert!(
        !msg.contains(dir.path().to_str().expect("utf8 路径")),
        "错误信息不应含真实目标：{msg}"
    );

    // 外部文件保持不变，合法内容仍可读。
    assert_eq!(std::fs::read(&outside).expect("读外部"), b"outside");
    assert_eq!(store.read(&store.write("keep/me.txt", b"kept").expect("再写")).expect("读回"), b"kept");
}

/// SPEC：元数据提交失败遗留的未引用内容可清理，已引用内容保持可读。
#[test]
fn sweep_removes_unreferenced_and_keeps_referenced_content() {
    let dir = tempfile::tempdir().expect("创建临时目录");
    let store = ContentStore::open(dir.path().join("content")).expect("打开存储");

    let referenced = store.write("a", b"referenced").expect("写入");
    let orphan = store.write("b", b"orphan").expect("写入");
    assert_ne!(referenced, orphan);

    // 元数据提交失败：引用表里只有 referenced，orphan 成为未引用内容。
    let removed = store
        .sweep_unreferenced(&[referenced.clone()], Duration::from_secs(0))
        .expect("清理");
    assert!(removed.contains(&orphan), "未引用内容应被删除：{removed:?}");
    assert!(!removed.contains(&referenced), "keep 列表内的内容不应删除");
    assert_eq!(
        store.read(&referenced).expect("已引用内容保持可读"),
        b"referenced"
    );
    assert!(store.read(&orphan).is_err(), "孤儿内容已删除");
}

/// 同内容幂等：重复写入返回同一 id 且对象唯一。
#[test]
fn content_write_is_idempotent() {
    let dir = tempfile::tempdir().expect("创建临时目录");
    let store = ContentStore::open(dir.path().join("content")).expect("打开存储");
    let id1 = store.write("x/a", b"same").expect("首次写入");
    let id2 = store.write("y/b", b"same").expect("重复写入");
    assert_eq!(id1, id2, "同内容应返回同一 id");
    let obj = store.test_object_path(&id1);
    assert!(obj.exists(), "对象应存在");
}

// ---- 夹具 ----

fn count_two_tables(db: &Database) -> (i64, i64) {
    let c1: i64 = db
        .with_conn(|conn| conn.query_row("SELECT COUNT(*) FROM t1", [], |r| r.get(0)))
        .expect("计数 t1");
    let c2: i64 = db
        .with_conn(|conn| conn.query_row("SELECT COUNT(*) FROM t2", [], |r| r.get(0)))
        .expect("计数 t2");
    (c1, c2)
}
