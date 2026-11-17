//! ExecutionEnv over Channel 验收：exec 走 SSH、write_file/read_file 走 SFTP，
//! 由进程内 SSH server 支撑。

#![allow(non_snake_case)]

mod common;

use std::sync::Arc;

use common::TestSshServer;
use ursi_channel::endpoint::AuthMethod;
use ursi_channel::env::ChannelEnv;
use ursi_domain::ExecutionEnv;

async fn spawn_env() -> (ChannelEnv, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("创建临时目录");
    let root = dir.path().to_path_buf();
    let key = ursi_channel::ssh::generate_keypair();
    let server = TestSshServer {
        host_key: key,
        user: "root".into(),
        password: "secret".into(),
        public_key: None,
        exec: Arc::new(|cmd| {
            if cmd == "fail" {
                (3, "boom".into())
            } else {
                (0, format!("env:{cmd}"))
            }
        }),
        sftp_root: root.clone(),
        addr: "127.0.0.1:0".parse().unwrap(),
    };
    let addr = server.spawn().await;
    std::mem::forget(dir);
    let env = ChannelEnv::new(
        "127.0.0.1",
        addr.port(),
        AuthMethod::Password {
            user: "root".into(),
            password: "secret".into(),
        },
    );
    (env, root)
}

#[tokio::test]
async fn exec_返回退出码与输出() {
    let (env, _root) = spawn_env().await;
    let (code, out) = env.exec("ls /").await.expect("exec 成功");
    assert_eq!(code, 0);
    assert_eq!(out, "env:ls /");
}

#[tokio::test]
async fn exec_非零退出码透传() {
    let (env, _root) = spawn_env().await;
    let (code, out) = env.exec("fail").await.expect("exec 正常返回");
    assert_eq!(code, 3);
    assert_eq!(out, "boom");
}

#[tokio::test]
async fn write_read_file_sftp往返() {
    let (env, _root) = spawn_env().await;
    let payload: Vec<u8> = (0..50 * 1024).map(|i| (i % 253) as u8).collect();
    env.write_file("/workspace/out.bin", &payload)
        .await
        .expect("write_file 成功");
    let got = env.read_file("/workspace/out.bin").await.expect("read_file 成功");
    assert_eq!(got, payload);
}

#[tokio::test]
#[allow(non_snake_case)]
async fn read_file_不存在返回FileNotFound() {
    let (env, _root) = spawn_env().await;
    let err = env.read_file("/nope.txt").await.unwrap_err();
    assert!(matches!(err, ursi_domain::EnvError::FileNotFound(_)), "{err}");
}

#[tokio::test]
async fn write_file_空内容() {
    let (env, _root) = spawn_env().await;
    env.write_file("/empty.txt", b"").await.expect("写入空文件");
    let got = env.read_file("/empty.txt").await.expect("读取空文件");
    assert!(got.is_empty());
}
