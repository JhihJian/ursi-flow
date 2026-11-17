import type { Role, Workflow, WorkflowNode } from '@/shared/api/types'

export type WorkflowDefinition = Pick<Workflow, 'name' | 'description' | 'nodes' | 'edges'>
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()

export function parseDefinition(name: string, description: string, nodeJson: string, edgeJson: string, roles: Role[]): WorkflowDefinition {
  if (!name.trim()) throw new Error('请填写工作流名称。')
  let nodes: unknown
  let edges: unknown
  try { nodes = JSON.parse(nodeJson) } catch { throw new Error('节点 JSON 格式不正确，请检查括号、引号和逗号。') }
  try { edges = JSON.parse(edgeJson) } catch { throw new Error('连线 JSON 格式不正确，请检查括号、引号和逗号。') }
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('节点必须是至少包含一个节点的数组。')
  if (!Array.isArray(edges)) throw new Error('连线必须是数组，无连线时填写 []。')
  const ids = new Set<string>()
  for (const [index, node] of nodes.entries()) {
    const prefix = `节点 ${index + 1}`
    if (!object(node) || !text(node.id) || !text(node.name)) throw new Error(`${prefix}：id 和 name 必填。`)
    if (ids.has(node.id)) throw new Error(`${prefix}：标识 ${node.id} 重复。`)
    ids.add(node.id)
    if (!['agent', 'approval', 'script'].includes(String(node.type))) throw new Error(`${prefix}：type 必须为 agent、approval 或 script。`)
    if (node.type === 'agent' && !text(node.roleId)) throw new Error(`${prefix}：agent 节点需要 roleId。`)
    if (node.roleId !== undefined && (!text(node.roleId) || !roles.some(role => role.id === node.roleId))) throw new Error(`${prefix}：请选择存在的角色，检查 roleId。`)
    if (node.type === 'script' && !text(node.script)) throw new Error(`${prefix}：script 节点需要脚本内容。`)
  }
  const edgeIds = new Set<string>()
  for (const [index, edge] of edges.entries()) {
    if (!object(edge) || !text(edge.source) || !text(edge.target) || !ids.has(edge.source) || !ids.has(edge.target)) throw new Error(`连线 ${index + 1}：source 和 target 必须指向已有节点。`)
    const key = JSON.stringify([edge.source, edge.target])
    if (edgeIds.has(key)) throw new Error(`连线 ${index + 1}：连线重复。`)
    edgeIds.add(key)
  }
  const typedEdges = edges as Workflow['edges']
  const remaining = new Set(ids)
  while (remaining.size) {
    const ready = [...remaining].filter(id => !typedEdges.some(edge => edge.target === id && remaining.has(edge.source)))
    if (!ready.length) throw new Error('流程存在循环依赖，请检查连线。')
    ready.forEach(id => remaining.delete(id))
  }
  return { name: name.trim(), description: description.trim(), nodes: nodes as WorkflowNode[], edges: typedEdges }
}

export const nodeTypeLabel: Record<WorkflowNode['type'], string> = { agent: '智能体', approval: '人工审批', script: '脚本' }
export const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
