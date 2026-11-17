#![allow(non_snake_case)]

//! 进程内测试基础设施：russh SSH server（exec + SFTP 子系统）与
//! TCP-over-WebSocket echo 隧道 server、纯 TCP echo server。
//!
//! 全部监听 127.0.0.1 随机端口，测试结束自动回收。

#![allow(dead_code)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use async_trait::async_trait;
use russh::keys::key::KeyPair;
use russh::server::{Auth, Handler, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{Data, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

/// SSH exec 请求的处理结果：固定输出与退出码。
pub type ExecFn = Arc<dyn Fn(&str) -> (i32, String) + Send + Sync>;

/// 测试用 SSH 服务器配置。
pub struct TestSshServer {
    /// 主机密钥。
    pub host_key: KeyPair,
    /// 接受的用户名。
    pub user: String,
    /// 接受的密码（password 鉴权用）。
    pub password: String,
    /// 接受的公钥（publickey 鉴权用），None 时拒绝公钥。
    pub public_key: Option<russh::keys::key::PublicKey>,
    /// exec 命令处理逻辑。
    pub exec: ExecFn,
    /// SFTP 后端根目录。
    pub sftp_root: std::path::PathBuf,
    /// 监听地址（bind 后填充）。
    pub addr: SocketAddr,
}

impl TestSshServer {
    /// 在 127.0.0.1 随机端口启动服务器，返回地址。
    pub async fn spawn(mut self) -> SocketAddr {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("绑定测试端口");
        self.addr = listener.local_addr().expect("读取测试端口");
        let addr = self.addr;
        let host_key = take_host_key(&mut self.host_key);
        let config = Arc::new(russh::server::Config {
            auth_rejection_time: std::time::Duration::from_millis(50),
            auth_rejection_time_initial: Some(std::time::Duration::from_millis(0)),
            keys: vec![host_key],
            ..Default::default()
        });
        let mut server = SshHandler {
            cfg: Arc::new(self),
            sessions: Mutex::new(HashMap::new()),
        };
        tokio::spawn(async move {
            let _ = server.run_on_socket(config, &listener).await;
        });
        addr
    }
}

/// 取出主机密钥，替换为新生成的占位密钥（KeyPair 无 Default）。
fn take_host_key(key: &mut KeyPair) -> KeyPair {
    let replacement = KeyPair::generate_ed25519().expect("生成替代密钥");
    std::mem::replace(key, replacement)
}

/// 每连接 Handler。
struct SshHandler {
    cfg: Arc<TestSshServer>,
    /// channel id -> 打开的 session 通道（SFTP 子系统接管时移除）。
    sessions: Mutex<HashMap<ChannelId, Channel<Msg>>>,
}

impl russh::server::Server for SshHandler {
    type Handler = Self;

    fn new_client(&mut self, _: Option<SocketAddr>) -> Self {
        Self {
            cfg: self.cfg.clone(),
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl Handler for SshHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == self.cfg.user && password == self.cfg.password {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None,
            })
        }
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        key: &russh::keys::key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        match &self.cfg.public_key {
            Some(allowed) if allowed.fingerprint() == key.fingerprint() => Ok(Auth::Accept),
            _ => Ok(Auth::Reject {
                proceed_with_methods: None,
            }),
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        self.sessions.lock().await.insert(channel.id(), channel);
        let _ = session;
        Ok(true)
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let cmd = String::from_utf8_lossy(data).into_owned();
        let (code, output) = (self.cfg.exec)(&cmd);
        // 按 SSH 单包安全大小分块发送。
        let output = output.into_bytes();
        for chunk in output.chunks(32768) {
            session.data(channel, chunk.to_vec().into());
        }
        session.exit_status_request(channel, code as u32);
        session.eof(channel);
        session.close(channel);
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(channel_id);
            return Ok(());
        }
        let channel = self.sessions.lock().await.remove(&channel_id);
        let Some(channel) = channel else {
            session.channel_failure(channel_id);
            return Ok(());
        };
        session.channel_success(channel_id);
        let handler = SftpHandler {
            root: self.cfg.sftp_root.clone(),
            handles: Mutex::new(HashMap::new()),
            next_handle: std::sync::atomic::AtomicU64::new(1),
        };
        russh_sftp::server::run(channel.into_stream(), handler).await;
        Ok(())
    }
}

/// 进程内 SFTP 后端：open/read/write/close/realpath/stat。
struct SftpHandler {
    root: std::path::PathBuf,
    handles: Mutex<HashMap<String, std::path::PathBuf>>,
    next_handle: std::sync::atomic::AtomicU64,
}

fn status(id: u32, code: StatusCode, msg: &str) -> Status {
    Status {
        id,
        status_code: code,
        error_message: msg.to_string(),
        language_tag: "en-US".to_string(),
    }
}

impl russh_sftp::server::Handler for SftpHandler {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> impl Future<Output = Result<Version, Self::Error>> + Send {
        async { Ok(Version::new()) }
    }

    fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> impl Future<Output = Result<Handle, Self::Error>> + Send {
        async move {
            let path = self.root.join(filename.trim_start_matches('/'));
            let wants_create = pflags.contains(OpenFlags::CREATE);
            let wants_write = pflags.contains(OpenFlags::WRITE);
            if wants_create || wants_write {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|_| {
                        status(id, StatusCode::Failure, "无法创建父目录").status_code
                    })?;
                }
                if wants_create && (pflags.contains(OpenFlags::TRUNCATE) || !path.exists()) {
                    std::fs::File::create(&path).map_err(|_| {
                        status(id, StatusCode::Failure, "无法创建文件").status_code
                    })?;
                }
            }
            // 纯 READ 打开不存在的文件必须报 NoSuchFile，不能悄悄创建。
            if !path.exists() {
                return Err(status(id, StatusCode::NoSuchFile, "文件不存在").status_code);
            }
            let handle = format!(
                "h{}",
                self.next_handle
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            );
            self.handles.lock().await.insert(handle.clone(), path);
            Ok(Handle { id, handle })
        }
    }

    fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> impl Future<Output = Result<Data, Self::Error>> + Send {
        async move {
            let path = {
                let handles = self.handles.lock().await;
                handles.get(&handle).cloned()
            };
            let Some(path) = path else {
                return Err(status(id, StatusCode::Failure, "无效句柄").status_code);
            };
            if !path.exists() {
                return Err(status(id, StatusCode::NoSuchFile, "文件不存在").status_code);
            }
            let mut file = std::fs::File::open(&path)
                .map_err(|_| status(id, StatusCode::Failure, "无法打开").status_code)?;
            use std::io::{Read, Seek};
            file.seek(std::io::SeekFrom::Start(offset))
                .map_err(|_| status(id, StatusCode::Failure, "seek 失败").status_code)?;
            let mut buf = vec![0u8; len as usize];
            let n = file
                .read(&mut buf)
                .map_err(|_| status(id, StatusCode::Failure, "读取失败").status_code)?;
            buf.truncate(n);
            Ok(Data { id, data: buf })
        }
    }

    fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> impl Future<Output = Result<Status, Self::Error>> + Send {
        async move {
            let path = {
                let handles = self.handles.lock().await;
                handles.get(&handle).cloned()
            };
            let Some(path) = path else {
                return Err(status(id, StatusCode::Failure, "无效句柄").status_code);
            };
            use std::io::{Seek, Write};
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .map_err(|_| status(id, StatusCode::Failure, "无法打开").status_code)?;
            file.seek(std::io::SeekFrom::Start(offset))
                .map_err(|_| status(id, StatusCode::Failure, "seek 失败").status_code)?;
            file.write_all(&data)
                .map_err(|_| status(id, StatusCode::Failure, "写入失败").status_code)?;
            Ok(status(id, StatusCode::Ok, "Ok"))
        }
    }

    fn close(
        &mut self,
        id: u32,
        _handle: String,
    ) -> impl Future<Output = Result<Status, Self::Error>> + Send {
        async move { Ok(status(id, StatusCode::Ok, "Ok")) }
    }

    fn realpath(
        &mut self,
        id: u32,
        path: String,
    ) -> impl Future<Output = Result<Name, Self::Error>> + Send {
        async move {
            let p = self.root.join(path.trim_start_matches('/'));
            Ok(Name {
                id,
                files: vec![russh_sftp::protocol::File {
                    filename: p.to_string_lossy().into_owned(),
                    attrs: FileAttributes::empty(),
                    longname: String::new(),
                }],
            })
        }
    }

    fn stat(
        &mut self,
        id: u32,
        path: String,
    ) -> impl Future<Output = Result<russh_sftp::protocol::Attrs, Self::Error>> + Send {
        async move {
            let p = self.root.join(path.trim_start_matches('/'));
            let meta = std::fs::metadata(&p)
                .map_err(|_| status(id, StatusCode::NoSuchFile, "文件不存在").status_code)?;
            let size = meta.len().try_into().unwrap_or(0);
            Ok(russh_sftp::protocol::Attrs {
                id,
                attrs: russh_sftp::protocol::FileAttributes {
                    size: Some(size),
                    ..FileAttributes::empty()
                },
            })
        }
    }
}

/// 纯 TCP echo server：监听 127.0.0.1 随机端口，回写全部收到的字节。
pub async fn spawn_tcp_echo() -> SocketAddr {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("绑定 echo 端口");
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if socket.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    addr
}

/// TCP-over-WebSocket echo 隧道：模拟 Gateway 隧道端。
///
/// 协议见 crate 文档：二进制帧回写；文本 "eof" 触发对端方向 "eof"；
/// 客户端发起 Close 后关闭；重复 eof / eof 后数据按契约直接关闭。
pub async fn spawn_tunnel_echo() -> SocketAddr {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("绑定隧道端口");
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let ws = match tokio_tungstenite::accept_hdr_async(stream, |req: &Request, mut resp: Response| {
                    // 校验子协议，未携带则拒绝握手。
                    let has_proto = req
                        .headers()
                        .get("Sec-WebSocket-Protocol")
                        .map(|v| v == "ursi-tcp-v1")
                        .unwrap_or(false);
                    if has_proto {
                        resp.headers_mut().append(
                            "Sec-WebSocket-Protocol",
                            httpHeaderValue("ursi-tcp-v1"),
                        );
                    }
                    Ok(resp)
                })
                .await
                {
                    Ok(ws) => ws,
                    Err(_) => return,
                };
                let (mut sink, mut source) = ws.split();
                while let Some(msg) = source.next().await {
                    let Ok(msg) = msg else { break };
                    match msg {
                        Message::Binary(data) => {
                            if sink.send(Message::Binary(data)).await.is_err() {
                                break;
                            }
                        }
                        Message::Text(text) => {
                            if text == "eof" {
                                // 模拟 Gateway：回发 eof，随后等待客户端 Close。
                                let _ = sink.send(Message::Text("eof".into())).await;
                                let _ = sink.close().await;
                                break;
                            }
                            // 其他文本：直接关闭。
                            let _ = sink.close().await;
                            break;
                        }
                        Message::Close(_) => {
                            let _ = sink.close().await;
                            break;
                        }
                        _ => {}
                    }
                }
            });
        }
    });
    addr
}

#[allow(non_snake_case)]
fn httpHeaderValue(v: &str) -> tokio_tungstenite::tungstenite::http::HeaderValue {
    tokio_tungstenite::tungstenite::http::HeaderValue::from_str(v).expect("合法 header 值")
}

type Request = tokio_tungstenite::tungstenite::http::Request<()>;
type Response = tokio_tungstenite::tungstenite::http::Response<()>;

/// 把字节按固定大小切块。
fn chunks_of(data: &[u8], size: usize) -> Vec<&[u8]> {
    data.chunks(size).collect()
}

use std::future::Future;
