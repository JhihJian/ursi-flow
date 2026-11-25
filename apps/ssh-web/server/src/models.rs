use serde::Serialize;

/// 一条 SSH 连接配置：名称 + 一条 ssh 命令。
/// 认证、跳板、端口等全部由命令与 `~/.ssh/config` 表达，无独立凭证字段。
#[derive(Debug, Clone, Serialize)]
pub struct Connection {
    pub id: i64,
    pub name: String,
    pub command: String,
    pub created_at: String,
    pub updated_at: String,
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
