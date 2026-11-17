//! 运行与节点状态机。

use serde::{Deserialize, Serialize};

use crate::workflow::WorkflowDefinition;

/// 运行状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Running,
    Waiting,
    Succeeded,
    Failed,
    Cancelled,
}

/// 节点状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Pending,
    Running,
    WaitingApproval,
    Succeeded,
    Failed,
    Cancelled,
    Skipped,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::Waiting => "waiting",
            RunStatus::Succeeded => "succeeded",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
        }
    }

    /// 判断字符串是否为合法运行状态。
    pub fn is_valid(s: &str) -> bool {
        Self::parse(s).is_some()
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "waiting" => Some(Self::Waiting),
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

impl NodeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            NodeStatus::Pending => "pending",
            NodeStatus::Running => "running",
            NodeStatus::WaitingApproval => "waiting_approval",
            NodeStatus::Succeeded => "succeeded",
            NodeStatus::Failed => "failed",
            NodeStatus::Cancelled => "cancelled",
            NodeStatus::Skipped => "skipped",
        }
    }

    /// 判断字符串是否为合法节点状态。
    pub fn is_valid(s: &str) -> bool {
        Self::parse(s).is_some()
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "running" => Some(Self::Running),
            "waiting_approval" => Some(Self::WaitingApproval),
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            "skipped" => Some(Self::Skipped),
            _ => None,
        }
    }
}

/// 节点运行状态记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRun {
    pub node_id: String,
    pub status: NodeStatus,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub reworks: u32,
}

/// 一次运行：从工作流定义实例化并冻结快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    /// 冻结的工作流快照，后续编辑工作流不影响在途运行。
    pub workflow: WorkflowDefinition,
    pub status: RunStatus,
    #[serde(default)]
    pub nodes: Vec<NodeRun>,
    /// 运行代数，用于状态提交守卫，拒绝过期写入。
    #[serde(default)]
    pub generation: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_status_as_str_parse_roundtrip() {
        let all = [
            RunStatus::Queued,
            RunStatus::Running,
            RunStatus::Waiting,
            RunStatus::Succeeded,
            RunStatus::Failed,
            RunStatus::Cancelled,
        ];
        for status in all {
            assert_eq!(RunStatus::parse(status.as_str()), Some(status));
            assert_eq!(status.as_str(), status.as_str());
        }
        // 全部状态标签互不相同。
        let labels: Vec<_> = all.iter().map(|s| s.as_str()).collect();
        assert_eq!(labels.len(), labels.iter().collect::<std::collections::HashSet<_>>().len());
    }

    #[test]
    fn node_status_as_str_parse_roundtrip() {
        let all = [
            NodeStatus::Pending,
            NodeStatus::Running,
            NodeStatus::WaitingApproval,
            NodeStatus::Succeeded,
            NodeStatus::Failed,
            NodeStatus::Cancelled,
            NodeStatus::Skipped,
        ];
        for status in all {
            assert_eq!(NodeStatus::parse(status.as_str()), Some(status));
        }
        let labels: Vec<_> = all.iter().map(|s| s.as_str()).collect();
        assert_eq!(labels.len(), labels.iter().collect::<std::collections::HashSet<_>>().len());
    }

    #[test]
    fn status_covers_spec_values() {
        let run_labels: Vec<_> = [
            RunStatus::Queued,
            RunStatus::Running,
            RunStatus::Waiting,
            RunStatus::Succeeded,
            RunStatus::Failed,
            RunStatus::Cancelled,
        ]
        .iter()
        .map(|s| s.as_str())
        .collect();
        assert_eq!(
            run_labels,
            vec!["queued", "running", "waiting", "succeeded", "failed", "cancelled"]
        );

        let node_labels: Vec<_> = [
            NodeStatus::Pending,
            NodeStatus::Running,
            NodeStatus::WaitingApproval,
            NodeStatus::Succeeded,
            NodeStatus::Failed,
            NodeStatus::Cancelled,
            NodeStatus::Skipped,
        ]
        .iter()
        .map(|s| s.as_str())
        .collect();
        assert_eq!(
            node_labels,
            vec![
                "pending",
                "running",
                "waiting_approval",
                "succeeded",
                "failed",
                "cancelled",
                "skipped"
            ]
        );
    }

    #[test]
    fn is_valid_rejects_illegal_strings() {
        for bad in ["", "Running", "queued ", "done", "unknown", "wait"] {
            assert!(!RunStatus::is_valid(bad), "{bad} 不应是合法运行状态");
            assert!(!NodeStatus::is_valid(bad), "{bad} 不应是合法节点状态");
        }
        assert!(RunStatus::is_valid("queued"));
        assert!(NodeStatus::is_valid("waiting_approval"));
    }

    #[test]
    fn status_serde_matches_as_str_labels() {
        for status in [
            RunStatus::Queued,
            RunStatus::Running,
            RunStatus::Waiting,
            RunStatus::Succeeded,
            RunStatus::Failed,
            RunStatus::Cancelled,
        ] {
            let json = serde_json::to_string(&status).unwrap();
            assert_eq!(json, format!("\"{}\"", status.as_str()));
            assert_eq!(serde_json::from_str::<RunStatus>(&json).unwrap(), status);
        }
        for status in [
            NodeStatus::Pending,
            NodeStatus::Running,
            NodeStatus::WaitingApproval,
            NodeStatus::Succeeded,
            NodeStatus::Failed,
            NodeStatus::Cancelled,
            NodeStatus::Skipped,
        ] {
            let json = serde_json::to_string(&status).unwrap();
            assert_eq!(json, format!("\"{}\"", status.as_str()));
            assert_eq!(serde_json::from_str::<NodeStatus>(&json).unwrap(), status);
        }
    }

    #[test]
    fn run_rejects_unknown_status_string() {
        assert!(serde_json::from_str::<RunStatus>("\"finished\"").is_err());
        assert!(serde_json::from_str::<NodeStatus>("\"done\"").is_err());
    }
}
