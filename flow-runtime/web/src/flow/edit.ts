// 图的编辑操作：只改图结构，小节正文由 syncSections 跟随。
import {
  edgeId,
  nextName,
  nextRef,
  type ActionKind,
  type FlowGraph,
  type GraphEdge,
  type GraphNode,
} from './graph'

const copy = (graph: FlowGraph): FlowGraph => ({
  ...graph,
  nodes: graph.nodes.map((node) => ({ ...node })),
  edges: graph.edges.map((edge) => ({ ...edge })),
})

function uniqueResult(graph: FlowGraph, ref: string, base: string): string {
  const used = new Set(
    graph.edges.filter((edge) => edge.from === ref).map((edge) => edge.result),
  )
  if (!used.has(base)) return base
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`
}

/** 新增工作节点或并行点。 */
export function addNode(
  graph: FlowGraph,
  kind: 'work' | 'parallel',
): { graph: FlowGraph; node: GraphNode } {
  const next = copy(graph)
  const node: GraphNode = {
    ref: nextRef(next, kind === 'parallel' ? 'parallel' : 'step'),
    name: nextName(next, kind === 'parallel' ? '并行' : '新节点'),
    kind,
    ...(kind === 'work' ? { actionKind: '新建Agent' as ActionKind } : {}),
  }
  next.nodes.push(node)
  return { graph: next, node }
}

export function renameNode(graph: FlowGraph, ref: string, name: string): FlowGraph {
  const next = copy(graph)
  const node = next.nodes.find((item) => item.ref === ref)
  if (node && name.trim()) node.name = name.trim()
  return next
}

export function setKind(graph: FlowGraph, ref: string, kind: ActionKind): FlowGraph {
  const next = copy(graph)
  const node = next.nodes.find((item) => item.ref === ref)
  if (node) node.actionKind = kind
  return next
}

/**
 * 改动作类型时同时修正出边，否则会留下规范不允许的组合：
 * 命令节点只能有一条“已执行”出边，执行Flow 用无结果直连边或 已完成/已失败 两条边。
 */
export function setActionKind(graph: FlowGraph, ref: string, kind: ActionKind): FlowGraph {
  const next = setKind(graph, ref, kind)
  const outs = next.edges.filter((edge) => edge.from === ref)
  if (!outs.length) return next
  const others = next.edges.filter((edge) => edge.from !== ref)
  if (kind === '执行自定义命令') {
    // 命令节点只保留一条出边，目标取原来的第一条。
    return replaceEdges(next, [
      ...others,
      { id: edgeId(ref, '已执行', outs[0].to), from: ref, to: outs[0].to, result: '已执行' },
    ])
  }
  if (kind === '执行Flow') {
    const pair = outs.filter((edge) => edge.result === '已完成' || edge.result === '已失败')
    if (pair.length === 2) return next
    return replaceEdges(next, [
      ...others,
      { id: edgeId(ref, undefined, outs[0].to), from: ref, to: outs[0].to },
    ])
  }
  // Agent 节点的每条出边都必须有结果名，缺失时补一个默认名字。
  const filled: GraphEdge[] = []
  for (const edge of outs) {
    if (edge.result) {
      filled.push(edge)
      continue
    }
    const result = uniqueResult({ ...next, edges: [...others, ...filled] }, ref, '已完成')
    filled.push({ ...edge, result, id: edgeId(ref, result, edge.to) })
  }
  return replaceEdges(next, [...others, ...filled])
}

export function removeNode(graph: FlowGraph, ref: string): FlowGraph {
  const next = copy(graph)
  next.nodes = next.nodes.filter((node) => node.ref !== ref)
  next.edges = next.edges.filter((edge) => edge.from !== ref && edge.to !== ref)
  return next
}

const replaceEdges = (graph: FlowGraph, edges: GraphEdge[]): FlowGraph => ({ ...graph, edges })

/** 命令节点只有一条“已执行”出边，执行Flow 只有直连出边，两者都不能再加结果。 */
export function fixedOutgoing(node: GraphNode): boolean {
  return node.actionKind === '执行自定义命令' || node.actionKind === '执行Flow'
}

/** 节点还能不能新增一条出边。 */
export function canAddOutgoing(graph: FlowGraph, node: GraphNode): boolean {
  if (node.kind === 'finish') return false
  return !fixedOutgoing(node) || !graph.edges.some((edge) => edge.from === node.ref)
}

/** 连接两个节点。sourceHandle 为空表示从节点的默认出口连出。 */
export function connect(
  graph: FlowGraph,
  from: string,
  to: string,
  sourceHandle?: string | null,
): FlowGraph {
  const node = graph.nodes.find((item) => item.ref === from)
  if (!node || from === to || node.kind === 'finish') return graph
  let result = sourceHandle && sourceHandle !== 'out' ? sourceHandle : undefined
  // 命令节点的唯一结果固定叫“已执行”，执行Flow 用无结果直连边。
  if (node.actionKind === '执行自定义命令') result = '已执行'
  if (node.actionKind === '执行Flow') result = undefined
  if (!result && node.kind === 'work' && !fixedOutgoing(node))
    result = uniqueResult(graph, from, '已执行')
  if (fixedOutgoing(node)) {
    // 只有一条出边时改连新目标，不制造出边重复。
    const others = graph.edges.filter((edge) => edge.from !== from)
    return replaceEdges(graph, [
      ...others,
      { id: edgeId(from, result, to), from, to, ...(result ? { result } : {}) },
    ])
  }
  if (node.kind === 'start') {
    const others = graph.edges.filter((edge) => edge.from !== from)
    return replaceEdges(graph, [...others, { id: edgeId(from, undefined, to), from, to }])
  }
  if (graph.edges.some((edge) => edge.from === from && edge.to === to && edge.result === result))
    return graph
  return replaceEdges(graph, [
    ...graph.edges,
    { id: edgeId(from, result, to), from, to, ...(result ? { result } : {}) },
  ])
}

export function removeEdge(graph: FlowGraph, id: string): FlowGraph {
  return replaceEdges(
    graph,
    graph.edges.filter((edge) => edge.id !== id),
  )
}

/** 改连线的去向；结果名与来源保持不变。 */
export function retargetEdge(graph: FlowGraph, id: string, to: string): FlowGraph {
  return replaceEdges(
    graph,
    graph.edges.map((edge) =>
      edge.id === id ? { ...edge, to, id: edgeId(edge.from, edge.result, to) } : edge,
    ),
  )
}

export function renameResult(graph: FlowGraph, id: string, name: string): FlowGraph {
  const trimmed = name.trim()
  const edge = graph.edges.find((item) => item.id === id)
  if (!edge || !trimmed) return graph
  if (graph.edges.some((other) => other.from === edge.from && other.result === trimmed && other.id !== id))
    return graph
  return replaceEdges(
    graph,
    graph.edges.map((other) =>
      other.id === id ? { ...other, result: trimmed, id: edgeId(other.from, trimmed, other.to) } : other,
    ),
  )
}

/** 为节点追加一条结果边，默认连到结束。 */
export function addResult(graph: FlowGraph, ref: string, target = 'finish'): FlowGraph {
  const result = uniqueResult(graph, ref, '已执行')
  const to = graph.nodes.some((node) => node.ref === target) ? target : 'finish'
  return replaceEdges(graph, [
    ...graph.edges,
    { id: edgeId(ref, result, to), from: ref, to, result },
  ])
}
