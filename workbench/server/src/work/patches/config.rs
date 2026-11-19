use super::{
    Error,
    directories::{Rules, fs},
};
use std::path::Path;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Work,
    Config,
}

impl Kind {
    pub(super) fn parse(key: &str) -> Option<Self> {
        match key {
            "work" => Some(Self::Work),
            "config" => Some(Self::Config),
            _ => None,
        }
    }
    pub(super) fn table(self) -> &'static str {
        match self {
            Self::Work => "workPatches",
            Self::Config => "configPatches",
        }
    }
    pub(super) fn rules(self) -> Rules {
        match self {
            Self::Work => Rules::default(),
            Self::Config => Rules {
                fixed: ["AGENTS.md", "skills", "mcp.json"]
                    .map(String::from)
                    .to_vec(),
                json_objects: vec!["mcp.json".into()],
            },
        }
    }
    pub(super) fn seed(self, root: &Path) -> Result<(), Error> {
        if self == Self::Config {
            fs::write(root, &["AGENTS.md".into()], b"", false)?;
            fs::mkdir(root, &["skills".into()])?;
            fs::write(root, &["mcp.json".into()], br#"{"mcpServers":{}}"#, false)?;
        }
        Ok(())
    }
}
