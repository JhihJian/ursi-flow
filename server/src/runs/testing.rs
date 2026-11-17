//! runs 测试支撑：手动推进的时钟替身与通用夹具。
//!
//! 仅测试编译（`#[cfg(test)]` 门控）。[`FakeClock`] 手动推进毫秒，
//! 用于模拟租约到期（SPEC「使用可控时钟模拟租约到期」）。

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use ursi_domain::{
    NodeRun, NodeStatus, NodeType, Run, RunStatus, WorkflowDefinition, WorkflowEdge, WorkflowNode,
};

use super::clock::Clock;

/// 手动推进的时钟替身：测试内 `advance` 控制时间流逝。
#[derive(Debug)]
pub(crate) struct FakeClock {
    now_ms: AtomicI64,
}

impl FakeClock {
    pub(crate) fn start_at(ms: i64) -> Arc<Self> {
        Arc::new(Self {
            now_ms: AtomicI64::new(ms),
        })
    }

    /// 推进时钟。
    pub(crate) fn advance(&self, ms: i64) {
        self.now_ms.fetch_add(ms, Ordering::SeqCst);
    }

    /// 当前毫秒读数。
    pub(crate) fn now(&self) -> i64 {
        self.now_ms.load(Ordering::SeqCst)
    }
}

impl Clock for FakeClock {
    fn now_millis(&self) -> i64 {
        self.now()
    }
}

/// 空节点骨架（按需补字段）。
pub(crate) fn bare_node(id: &str, node_type: NodeType) -> WorkflowNode {
    WorkflowNode {
        id: id.to_string(),
        name: id.to_string(),
        node_type,
        role_id: None,
        script: None,
        script_language: None,
        reject_to: None,
        max_attempts: 0,
        max_reworks: 0,
        artifact_outputs: Vec::new(),
        position: Default::default(),
    }
}

/// A → B → C 三节点链：A/C 为引用 r1 的 agent 节点，B 为脚本节点。
pub(crate) fn chain_workflow() -> WorkflowDefinition {
    let mut a = bare_node("A", NodeType::Agent);
    a.role_id = Some("r1".to_string());
    let b = bare_node("B", NodeType::Script);
    let mut c = bare_node("C", NodeType::Agent);
    c.role_id = Some("r1".to_string());
    WorkflowDefinition {
        id: "wf-chain".to_string(),
        name: "链式流程".to_string(),
        nodes: vec![a, b, c],
        edges: vec![
            WorkflowEdge {
                source: "A".to_string(),
                target: "B".to_string(),
            },
            WorkflowEdge {
                source: "B".to_string(),
                target: "C".to_string(),
            },
        ],
    }
}

/// 全 pending 的初始运行（generation=1, queued）。
pub(crate) fn initial_run(wf: &WorkflowDefinition) -> Run {
    Run {
        id: format!("run-{}", wf.id),
        workflow: wf.clone(),
        status: RunStatus::Queued,
        nodes: wf
            .nodes
            .iter()
            .map(|n| NodeRun {
                node_id: n.id.clone(),
                status: NodeStatus::Pending,
                output: None,
                error: None,
                attempts: 0,
                reworks: 0,
            })
            .collect(),
        generation: 1,
    }
}

/// 查找某节点状态（panic 版，测试内使用）。
pub(crate) fn node<'a>(run: &'a Run, node_id: &str) -> &'a NodeRun {
    run.nodes
        .iter()
        .find(|n| n.node_id == node_id)
        .unwrap_or_else(|| panic!("运行缺少节点 {node_id}"))
}
