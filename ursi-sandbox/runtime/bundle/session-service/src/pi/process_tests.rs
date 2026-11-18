use super::{Error, PiProcess, SpawnSpec};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    time::Duration,
};

#[tokio::test]
async fn pinned_cwd_spawn_and_missing_cleanup_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("repo");
    let moved = temp.path().join("moved");
    let outside = temp.path().join("outside");
    fs::create_dir(&original).unwrap();
    fs::create_dir(&outside).unwrap();
    let directory = fs::File::open(&original).unwrap();
    let identity = directory.metadata().unwrap();
    // 在获取句柄与启动之间替换路径，启动只允许使用已固定的目录对象。
    fs::rename(&original, &moved).unwrap();
    symlink(&outside, &original).unwrap();
    let fake = temp.path().join("supervisor");
    fs::write(
        &fake,
        r#"#!/usr/bin/python3
import json, os, signal, sys
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM})
stat = os.stat('.')
print(json.dumps(dict(cwd=os.getcwd(), dev=stat.st_dev, ino=stat.st_ino)), flush=True)
# 故意正常退出却不发送清理回执。
for line in sys.stdin:
    pass
"#,
    )
    .unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    let spec = SpawnSpec {
        bin: fake.clone(),
        runtime_dir: temp.path().into(),
        provider: "fake".into(),
        model: "fake".into(),
    };
    let mut process = PiProcess::spawn(spec, &fake, -1, &directory).unwrap();
    let event = tokio::time::timeout(Duration::from_secs(3), process.next())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event["cwd"], moved.to_str().unwrap());
    assert_eq!(event["dev"], identity.dev());
    assert_eq!(event["ino"], identity.ino());
    assert!(matches!(
        process.stop(false).await,
        Err(Error::CleanupUnconfirmed)
    ));
    assert_eq!(process.pid(), None);
}
