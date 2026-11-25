use serde::Serialize;

/// 连接类型：ssh 走 OpenSSH 子进程，local 直接在服务所在设备开 shell。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionKind {
    /// 服务所在设备的本机 shell（虚拟连接，不入库，固定 id 0）。
    Local,
    /// 远端连接：服务端启动 `ssh -tt` 子进程。
    #[default]
    Ssh,
}

/// 虚拟本机连接的固定 id 与名称。
pub const LOCAL_CONNECTION_ID: i64 = 0;
pub const LOCAL_CONNECTION_NAME: &str = "本机";


/// 一条 SSH 连接配置：名称 + 一条 ssh 命令。
/// 认证、跳板、端口等全部由命令与 `~/.ssh/config` 表达，无独立凭证字段。
#[derive(Debug, Clone, Serialize)]
pub struct Connection {
    pub id: i64,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub kind: ConnectionKind,
    pub created_at: String,
    pub updated_at: String,
}

/// 虚拟本机连接：固定 id 0，不入库、不可编辑删除，每次请求现构造。
pub fn local_connection() -> Connection {
    Connection {
        id: LOCAL_CONNECTION_ID,
        name: LOCAL_CONNECTION_NAME.into(),
        command: "登录 shell".into(),
        kind: ConnectionKind::Local,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct CreateConnectionRequest {
    pub name: String,
    pub command: String,
}

/// 更新时省略字段表示不改。
#[derive(Debug, serde::Deserialize)]
pub struct UpdateConnectionRequest {
    pub name: Option<String>,
    pub command: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateResponse {
    pub id: i64,
}

#[derive(Debug, Serialize)]
pub struct SuccessResponse {
    pub success: bool,
}

#[derive(Debug, Serialize)]
pub struct ConnectionsResponse {
    pub connections: Vec<Connection>,
}

/// 远端一条 tmux 会话：名称、attach 的客户端数、创建时间（unix 秒）。
#[derive(Debug, Clone, Serialize)]
pub struct TmuxSession {
    pub name: String,
    pub attached: u64,
    pub created: u64,
}

#[derive(Debug, Serialize)]
pub struct TmuxSessionsResponse {
    /// None 表示远端没有 tmux（已回退普通 shell）。
    pub sessions: Option<Vec<TmuxSession>>,
}

/// 校验并规整 ssh 命令：首词必须是 `ssh`。
/// 只做词法层校验，参数合法性交给 OpenSSH 自身。
pub fn validate_ssh_command(command: &str) -> Result<String, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("command 不能为空".into());
    }
    let first = trimmed.split_whitespace().next().unwrap_or_default();
    if first != "ssh" {
        return Err(format!("command 必须以 ssh 开头，收到：{first}"));
    }
    Ok(trimmed.to_string())
}

/// 校验创建请求，返回规整后的 (name, command)。
impl CreateConnectionRequest {
    pub fn validate(&self) -> Result<(String, String), String> {
        let name = self.name.trim();
        if name.is_empty() {
            return Err("name 不能为空".into());
        }
        let command = validate_ssh_command(&self.command)?;
        Ok((name.to_string(), command))
    }
}
