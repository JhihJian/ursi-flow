use serde::{Deserialize, Deserializer, Serialize};

/// 连接的认证方式：密码或私钥文件。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    Password,
    Key,
}

/// 一条 SSH 连接配置。`password` 与 `key_passphrase` 只入库，
/// 任何 API 响应都不回传。
#[derive(Debug, Clone, Serialize)]
pub struct Connection {
    pub id: i64,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub auth_type: AuthType,
    #[serde(skip_serializing)]
    pub password: Option<String>,
    pub key_path: Option<String>,
    #[serde(skip_serializing)]
    pub key_passphrase: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateConnectionRequest {
    pub name: String,
    pub host: String,
    pub port: Option<i64>,
    pub username: String,
    pub auth_type: AuthType,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub key_passphrase: Option<String>,
}

/// 更新时省略字段表示不改。
///
/// `password` 特殊：省略、`null` 或空串都表示保持原值，只有非空串才替换；
/// 这是唯一不回传给页面的字段，编辑表单无法展示旧值，留空即"不改"。
/// `key_path` 与 `key_passphrase` 会回传，空串与 `null` 都表示清空。
#[derive(Debug, Deserialize)]
pub struct UpdateConnectionRequest {
    pub name: Option<String>,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub username: Option<String>,
    pub auth_type: Option<AuthType>,
    #[serde(default, deserialize_with = "double_option")]
    pub password: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub key_path: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub key_passphrase: Option<Option<String>>,
}

fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
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

/// 创建时的最终字段视图：请求值合并默认值后做统一校验。
impl CreateConnectionRequest {
    pub fn resolved_port(&self) -> i64 {
        self.port.unwrap_or(22)
    }

    pub fn resolved_password(&self) -> Option<&str> {
        self.password
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    pub fn resolved_key_path(&self) -> Option<&str> {
        self.key_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    pub fn resolved_key_passphrase(&self) -> Option<&str> {
        self.key_passphrase
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("name 不能为空".into());
        }
        if self.host.trim().is_empty() {
            return Err("host 不能为空".into());
        }
        if self.username.trim().is_empty() {
            return Err("username 不能为空".into());
        }
        let port = self.resolved_port();
        if !(1..=65535).contains(&port) {
            return Err(format!("port 超出范围：{port}"));
        }
        match self.auth_type {
            AuthType::Password if self.resolved_password().is_none() => {
                return Err("密码认证需要提供 password".into());
            }
            AuthType::Key if self.resolved_key_path().is_none() => {
                return Err("密钥认证需要提供 key_path".into());
            }
            _ => {}
        }
        Ok(())
    }
}
