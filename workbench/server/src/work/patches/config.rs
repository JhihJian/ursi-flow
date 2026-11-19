//! 包的类别策略：目录键、新建时的初始内容，以及配置包锚点的保护规则。
//!
//! 目录服务只认相对路径；哪些路径对某一类包有额外含义只在这里判断。
use super::dir::{self, Fault};
use serde_json::Value;
use std::path::Path;

/// 配置包三个锚点：系统提示词、Skills 根目录和 MCP 配置。
pub(super) const PROMPT: &str = "AGENTS.md";
pub(super) const SKILLS: &str = "skills";
pub(super) const MCP: &str = "mcp.json";
const MCP_EMPTY: &str = "{\"mcpServers\":{}}";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Work,
    Config,
}

impl Kind {
    pub(super) fn parse(value: &str) -> Option<Self> {
        match value {
            "work" => Some(Self::Work),
            "config" => Some(Self::Config),
            _ => None,
        }
    }

    /// 私有根下的类别键，同时决定两类包的存储隔离。
    pub(super) fn key(self) -> &'static str {
        match self {
            Self::Work => "work",
            Self::Config => "config",
        }
    }

    /// 新建包的初始内容：工作包留空，配置包先建立三个锚点。
    pub(super) fn seed(self, root: &Path) -> Result<(), Fault> {
        match self {
            Self::Work => Ok(()),
            Self::Config => {
                let prompt = vec![PROMPT.to_owned()];
                let skills = vec![SKILLS.to_owned()];
                let mcp = vec![MCP.to_owned()];
                dir::write(root, &prompt, b"", false)?;
                dir::mkdir(root, &skills)?;
                dir::write(root, &mcp, MCP_EMPTY.as_bytes(), false)
            }
        }
    }

    /// 写入前的类别校验，在取得写锁之前完成。
    pub(super) fn check_write(self, path: &str, bytes: &[u8]) -> Result<(), Fault> {
        if self == Self::Config && path == MCP {
            let value: Value = serde_json::from_slice(bytes)
                .map_err(|_| Fault::Invalid("mcp.json 必须是合法的 JSON".into()))?;
            if !value.is_object() {
                return Err(Fault::Invalid("mcp.json 顶层必须是 JSON 对象".into()));
            }
        }
        Ok(())
    }

    /// 锚点不能改名移动，也不能删除。
    pub(super) fn check_move(self, from: &str, to: &str) -> Result<(), Fault> {
        if self.anchor(from) || self.anchor(to) {
            return Err(Fault::Conflict(
                "系统提示词、skills/ 与 mcp.json 的位置固定，不能移动".into(),
            ));
        }
        Ok(())
    }

    pub(super) fn check_remove(self, path: &str) -> Result<(), Fault> {
        if self.anchor(path) {
            return Err(Fault::Conflict(
                "系统提示词、skills/ 与 mcp.json 不能删除".into(),
            ));
        }
        Ok(())
    }

    fn anchor(self, path: &str) -> bool {
        self == Self::Config && matches!(path, PROMPT | SKILLS | MCP)
    }
}
