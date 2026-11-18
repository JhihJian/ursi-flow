//! 工作流结构定义、解析与校验。

use serde::{Deserialize, Serialize};

/// 工作流节点类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    /// Agent 节点：引用角色，由执行器运行。
    Agent,
    /// 脚本节点：确定性的 shell/python 步骤。
    Script,
    /// 审批节点：暂停等待人工放行或打回。
    Approval,
}

/// 节点在画布上的位置，仅用于展示，不参与调度语义。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

/// 节点声明的产物契约。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactContract {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub required: bool,
    /// 声明的内容类型（如 "text/markdown"）。
    #[serde(default)]
    pub media_type: Option<String>,
}

/// 工作流节点。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNode {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    /// agent 节点引用的角色 ID。
    #[serde(default)]
    pub role_id: Option<String>,
    /// script 节点的脚本内容。
    #[serde(default)]
    pub script: Option<String>,
    /// 脚本语言：shell 或 python。
    #[serde(default)]
    pub script_language: Option<String>,
    /// 审批打回的目标节点 ID。
    #[serde(default)]
    pub reject_to: Option<String>,
    #[serde(default)]
    pub max_attempts: u32,
    #[serde(default)]
    pub max_reworks: u32,
    #[serde(default)]
    pub artifact_outputs: Vec<ArtifactContract>,
    #[serde(default)]
    pub position: Position,
}

/// 工作流边：从 source 指向 target 的执行依赖。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowEdge {
    pub source: String,
    pub target: String,
}

/// 工作流定义：节点集合与边集合构成的有向无环图（DAG）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowDefinition {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub nodes: Vec<WorkflowNode>,
    #[serde(default)]
    pub edges: Vec<WorkflowEdge>,
}

/// 工作流解析与校验错误。
#[derive(Debug, thiserror::Error)]
pub enum WorkflowError {
    #[error("节点 ID 不能为空")]
    MissingNodeId,
    #[error("节点 {0} 的 ID 重复")]
    DuplicateNodeId(String),
    #[error("边引用了不存在的节点")]
    EdgeReferencesMissingNode,
    #[error("工作流必须是无环图，检测到环")]
    CycleDetected,
    #[error("节点 {0} 校验失败：{1}")]
    InvalidNode(String, String),
    #[error("JSON 解析失败：{0}")]
    Parse(#[from] serde_json::Error),
}

/// 把 JSON 解析为工作流定义。
pub fn parse_workflow(input: &str) -> Result<WorkflowDefinition, WorkflowError> {
    Ok(serde_json::from_str(input)?)
}

/// 校验工作流定义：节点字段语义 + DAG 无环。
pub fn validate_workflow(wf: &WorkflowDefinition) -> Result<(), WorkflowError> {
    let mut ids = std::collections::HashSet::new();
    for node in &wf.nodes {
        if node.id.trim().is_empty() {
            return Err(WorkflowError::MissingNodeId);
        }
        if !ids.insert(node.id.clone()) {
            return Err(WorkflowError::DuplicateNodeId(node.id.clone()));
        }
        validate_node(node)?;
    }
    validate_dag(ids, &wf.edges)
}

fn validate_node(node: &WorkflowNode) -> Result<(), WorkflowError> {
    match node.node_type {
        NodeType::Agent => {
            if node.role_id.as_deref().is_none_or(|s| s.trim().is_empty()) {
                return Err(WorkflowError::InvalidNode(
                    node.id.clone(),
                    "agent 节点必须引用角色".to_string(),
                ));
            }
        }
        NodeType::Script => {
            if node.script.as_deref().is_none_or(|s| s.trim().is_empty()) {
                return Err(WorkflowError::InvalidNode(
                    node.id.clone(),
                    "script 节点必须提供脚本".to_string(),
                ));
            }
        }
        NodeType::Approval => {}
    }
    Ok(())
}

/// 用 Kahn 拓扑排序校验 DAG 无环，且边不引用未知节点。
fn validate_dag(
    ids: std::collections::HashSet<String>,
    edges: &[WorkflowEdge],
) -> Result<(), WorkflowError> {
    use std::collections::{HashMap, VecDeque};

    let mut indegree: HashMap<String, usize> = ids.iter().map(|id| (id.clone(), 0)).collect();
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();

    for edge in edges {
        if !ids.contains(&edge.source) || !ids.contains(&edge.target) {
            return Err(WorkflowError::EdgeReferencesMissingNode);
        }
        *indegree.get_mut(&edge.target).unwrap() += 1;
        adj.entry(edge.source.clone())
            .or_default()
            .push(edge.target.clone());
    }

    let mut queue: VecDeque<String> = indegree
        .iter()
        .filter(|&(_, &d)| d == 0)
        .map(|(id, _)| id.clone())
        .collect();

    let mut seen = 0;
    while let Some(id) = queue.pop_front() {
        seen += 1;
        if let Some(nexts) = adj.get(&id) {
            for next in nexts {
                let d = indegree.get_mut(next).unwrap();
                *d -= 1;
                if *d == 0 {
                    queue.push_back(next.clone());
                }
            }
        }
    }

    if seen != ids.len() {
        return Err(WorkflowError::CycleDetected);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_validates_chain_workflow() {
        let wf = parse_workflow(
            r#"{
                "id": "wf1", "name": "demo",
                "nodes": [
                    {"id": "A", "name": "设计", "type": "agent", "roleId": "r1"},
                    {"id": "B", "name": "审批", "type": "approval", "rejectTo": "A"},
                    {"id": "C", "name": "实现", "type": "agent", "roleId": "r1"}
                ],
                "edges": [
                    {"source": "A", "target": "B"},
                    {"source": "B", "target": "C"}
                ]
            }"#,
        )
        .unwrap();
        assert_eq!(wf.nodes.len(), 3);
        assert_eq!(wf.edges.len(), 2);
        validate_workflow(&wf).unwrap();
    }

    #[test]
    fn rejects_cycle() {
        let wf = parse_workflow(
            r#"{
                "id": "wf2", "name": "cyclic",
                "nodes": [
                    {"id": "A", "name": "x", "type": "approval"},
                    {"id": "B", "name": "y", "type": "approval"}
                ],
                "edges": [
                    {"source": "A", "target": "B"},
                    {"source": "B", "target": "A"}
                ]
            }"#,
        )
        .unwrap();
        assert!(matches!(
            validate_workflow(&wf),
            Err(WorkflowError::CycleDetected)
        ));
    }

    #[test]
    fn rejects_edge_to_missing_node() {
        let wf = parse_workflow(
            r#"{
                "id": "wf3", "name": "missing",
                "nodes": [{"id": "A", "name": "x", "type": "approval"}],
                "edges": [{"source": "A", "target": "Z"}]
            }"#,
        )
        .unwrap();
        assert!(matches!(
            validate_workflow(&wf),
            Err(WorkflowError::EdgeReferencesMissingNode)
        ));
    }

    #[test]
    fn rejects_duplicate_node_id() {
        let wf = parse_workflow(
            r#"{
                "id": "wf5", "name": "dup",
                "nodes": [
                    {"id": "A", "name": "x", "type": "approval"},
                    {"id": "A", "name": "y", "type": "approval"}
                ],
                "edges": []
            }"#,
        )
        .unwrap();
        assert!(matches!(
            validate_workflow(&wf),
            Err(WorkflowError::DuplicateNodeId(_))
        ));
    }

    #[test]
    fn rejects_empty_node_id() {
        let wf = parse_workflow(
            r#"{
                "id": "wf6", "name": "empty-id",
                "nodes": [{"id": " ", "name": "x", "type": "approval"}],
                "edges": []
            }"#,
        )
        .unwrap();
        assert!(matches!(
            validate_workflow(&wf),
            Err(WorkflowError::MissingNodeId)
        ));
    }

    #[test]
    fn rejects_script_node_with_empty_script() {
        let wf = parse_workflow(
            r#"{
                "id": "wf7", "name": "empty-script",
                "nodes": [
                    {"id": "S", "name": "脚本", "type": "script", "script": "  "}
                ],
                "edges": []
            }"#,
        )
        .unwrap();
        assert!(matches!(
            validate_workflow(&wf),
            Err(WorkflowError::InvalidNode(_, _))
        ));
    }

    #[test]
    fn rejects_unknown_node_type() {
        let result = parse_workflow(
            r#"{
                "id": "wf8", "name": "bad-type",
                "nodes": [{"id": "A", "name": "x", "type": "workflow"}],
                "edges": []
            }"#,
        );
        assert!(result.is_err(), "未知节点 type 必须解析失败");
    }

    #[test]
    fn parses_artifact_contract_with_camel_case_fields() {
        let wf = parse_workflow(
            r#"{
                "id": "wf9", "name": "artifacts",
                "nodes": [
                    {"id": "A", "name": "写作", "type": "agent", "roleId": "r1",
                     "artifactOutputs": [
                        {"name": "报告", "path": "out/report.md", "required": true,
                         "mediaType": "text/markdown"}
                     ]}
                ],
                "edges": []
            }"#,
        )
        .unwrap();
        validate_workflow(&wf).unwrap();
        let contract = &wf.nodes[0].artifact_outputs[0];
        assert_eq!(contract.name, "报告");
        assert_eq!(contract.path, "out/report.md");
        assert!(contract.required);
        assert_eq!(contract.media_type.as_deref(), Some("text/markdown"));
    }

    #[test]
    fn rejects_agent_node_without_role() {
        let wf = parse_workflow(
            r#"{
                "id": "wf4", "name": "no-role",
                "nodes": [{"id": "A", "name": "x", "type": "agent"}],
                "edges": []
            }"#,
        )
        .unwrap();
        assert!(matches!(
            validate_workflow(&wf),
            Err(WorkflowError::InvalidNode(_, _))
        ));
    }
}
