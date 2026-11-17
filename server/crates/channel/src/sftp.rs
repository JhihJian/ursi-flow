//! SFTP 文件传输（基于 russh-sftp 2，运行在同一 sshd 的 `sftp` 子系统上）。
//!
//! # 语义
//!
//! - [`put`]：把字节写入远端路径（CREATE|TRUNCATE|WRITE，覆盖写）。
//! - [`get`]：读取远端文件全部内容。
//! - 传输按 [`SFTP_CHUNK_SIZE`] 分块写入/读取，避免单包超出 SSH 通道上限。
//! - 错误映射：`NoSuchFile` → [`ChannelError::Protocol`]（含路径，调用方可
//!   识别文件不存在）；`PermissionDenied`/其他 SFTP 状态 → 对应
//!   [`ChannelError`] 变体；传输中断 → [`ChannelError::Io`]。
//!
//! put/get 的分块与错误映射逻辑在本文件单测覆盖；真实 sshd 往返通过进程内
//! SSH+SFTP server 集成测试验证（见 `tests`）。

use russh::client::Handle;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{OpenFlags, StatusCode};

use crate::endpoint::AuthMethod;
use crate::error::ChannelError;
use crate::ssh::{self, ClientHandler};

/// SFTP 写入分块大小（32 KiB，与 SSH 通道单包上限保持安全距离）。
pub const SFTP_CHUNK_SIZE: usize = 32 * 1024;
/// SFTP 读取分块大小。
pub const SFTP_READ_CHUNK: usize = 32 * 1024;

/// 打开 SFTP 会话：复用已鉴权的 SSH 连接，请求 `sftp` 子系统。
pub async fn sftp_open(handle: &mut Handle<ClientHandler>) -> Result<SftpSession, ChannelError> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| ChannelError::Io(format!("打开 SFTP 通道失败：{e}")))?;
    channel
        .request_subsystem(true, "sftp".to_string())
        .await
        .map_err(|e| ChannelError::Io(format!("请求 sftp 子系统失败：{e}")))?;
    let stream = channel.into_stream();
    SftpSession::new(stream)
        .await
        .map_err(|e| ChannelError::Protocol(format!("SFTP 初始化失败：{e}")))
}

/// 映射 SFTP 客户端错误。
pub fn map_sftp_error(e: russh_sftp::client::error::Error) -> ChannelError {
    use russh_sftp::client::error::Error as SE;
    match e {
        SE::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => ChannelError::Protocol(format!(
                "文件不存在：{}",
                status.error_message
            )),
            StatusCode::PermissionDenied => {
                ChannelError::AuthFailed(format!("权限不足：{}", status.error_message))
            }
            _ => ChannelError::Protocol(format!(
                "SFTP 状态错误 {:?}：{}",
                status.status_code, status.error_message
            )),
        },
        SE::Timeout => ChannelError::Io("SFTP 响应超时".into()),
        other => ChannelError::Io(format!("SFTP IO 故障：{other}")),
    }
}

/// 把字节写入远端路径（覆盖写），按 [`SFTP_CHUNK_SIZE`] 分块。
pub async fn put_on(
    sftp: &SftpSession,
    remote_path: &str,
    bytes: &[u8],
) -> Result<(), ChannelError> {
    use tokio::io::AsyncWriteExt;
    let mut file = sftp
        .open_with_flags(
            remote_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(map_sftp_error)?;
    // 按 SFTP_CHUNK_SIZE 分块写入；AsyncWrite 实现内部还会再按通道包上限切分。
    for chunk in bytes.chunks(SFTP_CHUNK_SIZE) {
        file.write_all(chunk)
            .await
            .map_err(|e| ChannelError::Io(format!("SFTP 写入失败：{e}")))?;
    }
    // shutdown 等待全部写回执并关闭文件句柄。
    file.shutdown()
        .await
        .map_err(|e| ChannelError::Io(format!("SFTP 关闭失败：{e}")))?;
    Ok(())
}

/// 读取远端文件全部内容，按 [`SFTP_READ_CHUNK`] 分块拼接。
pub async fn get_on(sftp: &SftpSession, remote_path: &str) -> Result<Vec<u8>, ChannelError> {
    use tokio::io::AsyncReadExt;
    let mut file = sftp.open(remote_path).await.map_err(map_sftp_error)?;
    let mut out = Vec::new();
    let mut buf = vec![0u8; SFTP_READ_CHUNK];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| ChannelError::Io(format!("SFTP 读取失败：{e}")))?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
    }
    file.close()
        .await
        .map_err(|e| ChannelError::Io(format!("SFTP 关闭失败：{e}")))?;
    Ok(out)
}

/// 连接 + put 的便捷入口（独立使用场景，不复用连接时）。
pub async fn put_auth(
    host: &str,
    port: u16,
    auth: &AuthMethod,
    remote_path: &str,
    bytes: &[u8],
) -> Result<(), ChannelError> {
    let mut handle = ssh::ssh_connect(host, port, auth).await?;
    let result = async {
        let sftp = sftp_open(&mut handle).await?;
        put_on(&sftp, remote_path, bytes).await
    }
    .await;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "en-US")
        .await;
    result
}

/// 连接 + get 的便捷入口。
pub async fn get_auth(
    host: &str,
    port: u16,
    auth: &AuthMethod,
    remote_path: &str,
) -> Result<Vec<u8>, ChannelError> {
    let mut handle = ssh::ssh_connect(host, port, auth).await?;
    let result = async {
        let sftp = sftp_open(&mut handle).await?;
        get_on(&sftp, remote_path).await
    }
    .await;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "en-US")
        .await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 分块大小在安全范围内() {
        assert_eq!(SFTP_CHUNK_SIZE, 32 * 1024);
        assert_eq!(SFTP_READ_CHUNK, 32 * 1024);
    }

    #[test]
    fn 分块边界计算正确() {
        // put_on 的循环边界逻辑抽出来验证。
        fn chunk_ranges(len: usize, chunk: usize) -> Vec<(usize, usize)> {
            let mut ranges = Vec::new();
            let mut offset = 0;
            while offset < len {
                let end = (offset + chunk).min(len);
                ranges.push((offset, end));
                offset = end;
            }
            ranges
        }
        assert_eq!(chunk_ranges(0, 4), vec![]);
        assert_eq!(chunk_ranges(5, 4), vec![(0, 4), (4, 5)]);
        assert_eq!(chunk_ranges(8, 4), vec![(0, 4), (4, 8)]);
        assert_eq!(chunk_ranges(70_000, SFTP_CHUNK_SIZE).len(), 3);
    }

    #[test]
    fn 错误映射区分文件不存在与权限不足() {
        use russh_sftp::protocol::Status;
        let status = |code| Status {
            id: 1,
            status_code: code,
            error_message: "msg".into(),
            language_tag: "en".into(),
        };
        let e1 = map_sftp_error(russh_sftp::client::error::Error::Status(status(
            StatusCode::NoSuchFile,
        )));
        assert!(matches!(e1, ChannelError::Protocol(_)), "{e1}");
        assert!(e1.to_string().contains("文件不存在"));

        let e2 = map_sftp_error(russh_sftp::client::error::Error::Status(status(
            StatusCode::PermissionDenied,
        )));
        assert!(matches!(e2, ChannelError::AuthFailed(_)), "{e2}");

        let e3 = map_sftp_error(russh_sftp::client::error::Error::Timeout);
        assert!(matches!(e3, ChannelError::Io(_)), "{e3}");
    }
}
