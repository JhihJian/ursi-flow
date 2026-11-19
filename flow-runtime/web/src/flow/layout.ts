// 图布局：按分层方向计算节点位置。位置只是界面状态，不写回 FLOW.md。
import dagre from 'dagre'
import { FINISH, START, type FlowGraph } from './graph'

export interface Point {
  x: number
  y: number
}
const size: Record<string, { width: number; height: number }> = {
  start: { width: 120, height: 52 },
  finish: { width: 120, height: 52 },
  parallel: { width: 132, height: 60 },
  work: { width: 236, height: 132 },
}

/** 自上而下分层，返回每个引用名的左上角坐标。 */
export function layoutGraph(graph: FlowGraph): Record<string, Point> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 56, ranksep: 76, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const node of graph.nodes) {
    const box = size[node.kind] ?? size.work
    g.setNode(node.ref, { ...box })
  }
  // 反向边（循环）会让分层过高，交给 dagre 正常处理即可。
  for (const edge of graph.edges) if (g.hasNode(edge.from) && g.hasNode(edge.to)) g.setEdge(edge.from, edge.to)
  dagre.layout(g)
  const result: Record<string, Point> = {}
  for (const node of graph.nodes) {
    const placed = g.node(node.ref)
    const box = size[node.kind] ?? size.work
    result[node.ref] = { x: (placed?.x ?? 0) - box.width / 2, y: (placed?.y ?? 0) - box.height / 2 }
  }
  return result
}

export const nodeSize = (kind: string) => size[kind] ?? size.work
export const terminalRefs = new Set([START, FINISH])
