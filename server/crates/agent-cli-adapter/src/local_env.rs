//! 进程内 LocalEnv 测试替身：以临时目录为根的本地执行环境实现。
//!
//! 仅用于测试编译（`#[cfg(test)]`），不在生产面暴露。它以真实的
//! `std::process::Command` + `sh -c` 执行命令、真实的文件系统写入与读取，
//! 验证 capability 渲染落盘与 CliAdapter 启动在沙箱内的实际执行效果；
//! 生产环境由装配方注入真正的沙箱 ExecutionEnv 实现。
//!
//! 与 domain 契约的对齐约定：
//! - 所有路径以 workspace 根（临时目录）为基准拼接；
//! - [`ExecutionEnv::exec`] 接收单条命令字符串，以 `sh -c` 在 workspace
//!   根执行，返回 `(退出码, 合并输出)`；
//! - `write_file` 自动创建父目录。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use async_trait::async_trait;
use ursi_domain::{EnvError, ExecutionEnv};

/// 本地执行环境：命令与文件操作都落在根目录内。
pub struct LocalEnv {
    root: PathBuf,
}

impl LocalEnv {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn resolve(&self, path: &str) -> PathBuf {
        let p = Path::new(path);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.root.join(p)
        }
    }
}

#[async_trait]
impl ExecutionEnv for LocalEnv {
    async fn exec(&self, cmd: &str) -> Result<(i32, String), EnvError> {
        let cmd = cmd.to_string();
        let cwd = self.root.clone();
        // 测试替身用阻塞进程模型即可；命令在 workspace 根内执行。
        let out = tokio::task::spawn_blocking(move || {
            Command::new("sh")
                .arg("-c")
                .arg(&cmd)
                .current_dir(&cwd)
                .output()
        })
        .await
        .map_err(|e| EnvError::Exec(format!("join 失败：{e}")))?
        .map_err(|e| EnvError::Exec(format!("命令启动失败：{e}")))?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        Ok((out.status.code().unwrap_or(-1), text))
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> Result<(), EnvError> {
        let target = self.resolve(path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| EnvError::Other(format!("创建目录失败：{e}")))?;
        }
        std::fs::write(&target, content).map_err(|e| EnvError::Other(format!("写入失败：{e}")))
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, EnvError> {
        let target = self.resolve(path);
        std::fs::read(&target).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                EnvError::FileNotFound(path.to_string())
            } else {
                EnvError::Other(format!("读取失败：{e}"))
            }
        })
    }
}

/// 供需要 `Arc<dyn ExecutionEnv>` 的装配方（Runner::run）使用。
pub fn shared(root: PathBuf) -> Arc<dyn ExecutionEnv> {
    Arc::new(LocalEnv::new(root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exec_runs_in_root_and_merges_output() {
        let tmp = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(tmp.path().to_path_buf());
        env.write_file("hi.txt", b"ok".as_slice()).await.unwrap();

        let (code, out) = env.exec("cat hi.txt && echo done >&2").await.unwrap();
        assert_eq!(code, 0);
        assert!(out.contains("ok"));
        assert!(out.contains("done"));
    }

    #[tokio::test]
    async fn exec_nonzero_exit_keeps_output() {
        let tmp = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(tmp.path().to_path_buf());
        let (code, out) = env.exec("echo before; exit 3").await.unwrap();
        assert_eq!(code, 3);
        assert!(out.contains("before"));
    }

    #[tokio::test]
    async fn write_creates_parents_and_read_reports_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(tmp.path().to_path_buf());
        env.write_file("a/b/c.txt", b"x".as_slice()).await.unwrap();
        assert_eq!(env.read_file("a/b/c.txt").await.unwrap(), b"x");
        assert!(matches!(
            env.read_file("no/such").await,
            Err(EnvError::FileNotFound(_))
        ));
    }
}
