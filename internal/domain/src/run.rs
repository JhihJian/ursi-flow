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
