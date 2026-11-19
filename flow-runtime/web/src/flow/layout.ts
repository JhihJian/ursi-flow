// 图布局：左到右分层，返回节点坐标与连线走线。位置只是界面状态，不写回 FLOW.md。
import dagre from 'dagre'
import { type FlowGraph, type GraphNode } from './graph'

export interface Point {
  x: number
  y: number
}

interface Box {
  width: number
  height: number
}

// 终端与并行点的宽度由样式表 .cterminal / .cparallel 的最小宽度决定。
const TERMINAL: Box = { width: 104, height: 44 }
const PARALLEL: Box = { width: 132, height: 46 }
// 与样式表 .cnode 的宽度保持一致。
const WORK_WIDTH = 212
const OUTLET_HEIGHT = 24
const WORK_BASE = 90
const LANE_GAP = 22

/** 工作卡片高度随结果边行数增长，布局按实际行数留位，否则多出口节点会与下游重叠。 */
export function workHeight(outlets: number): number {
  return WORK_BASE + Math.max(outlets, 1) * OUTLET_HEIGHT
}

/** 节点外框尺寸，节点卡片与布局共用同一套数字。 */
export function nodeSize(node: GraphNode, graph: FlowGraph): Box {
  if (node.kind === 'parallel') return PARALLEL
  if (node.kind !== 'work') return TERMINAL
  const outlets = graph.edges.filter((edge) => edge.from === node.ref).length
  return { width: WORK_WIDTH, height: workHeight(outlets) }
}

/**
 * 回边（例如“未通过 → 返工”再回到评审）不参与分层，主路径才能自左向右读。
 * 按模型顺序从开始节点做深度优先遍历，指向遍历栈中节点的边就是回边。
 */
export function findBackEdges(graph: FlowGraph): Set<string> {
  const ids = new Set(graph.nodes.map((node) => node.ref))
  const out = new Map<string, { id: string; to: string }[]>()
  for (const node of graph.nodes) out.set(node.ref, [])
  for (const edge of graph.edges)
    if (ids.has(edge.from) && ids.has(edge.to)) out.get(edge.from)!.push({ id: edge.id, to: edge.to })
  const roots = [
    ...graph.nodes.filter((node) => node.kind === 'start'),
    ...graph.nodes.filter((node) => node.kind !== 'start'),
  ].map((node) => node.ref)
  const state = new Map<string, 1 | 2>()
  const back = new Set<string>()
  for (const root of roots) {
    if (state.has(root)) continue
    const stack = [{ id: root, index: 0 }]
    state.set(root, 1)
    while (stack.length) {
      const top = stack[stack.length - 1]
      const list = out.get(top.id) ?? []
      if (top.index >= list.length) {
        state.set(top.id, 2)
        stack.pop()
        continue
      }
      const edge = list[top.index++]
      const seen = state.get(edge.to)
      if (seen === 1) back.add(edge.id)
      else if (!seen) {
        state.set(edge.to, 1)
        stack.push({ id: edge.to, index: 0 })
      }
    }
  }
  return back
}

export interface FlowLayout {
  /** 每个引用名的左上角坐标。 */
  positions: Record<string, Point>
  /** 只含中间折点的走线；回边由 layout 直接给到底部绕行折点。 */
  routes: Record<string, Point[]>
  back: Set<string>
}

export function layoutGraph(graph: FlowGraph): FlowLayout {
  const g = new dagre.graphlib.Graph()
  // 连线从左向右展开，与卡片左侧入口、右侧出口一致。
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 68, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))
  const boxes = new Map(graph.nodes.map((node) => [node.ref, nodeSize(node, graph)]))
  for (const node of graph.nodes) {
    const box = boxes.get(node.ref) ?? TERMINAL
    g.setNode(node.ref, { width: box.width, height: box.height })
  }
  const back = findBackEdges(graph)
  // 回边不进分层，否则整张图会被拉长一倍；它们另外沿底部绕行。
  for (const edge of graph.edges)
    if (!back.has(edge.id) && g.hasNode(edge.from) && g.hasNode(edge.to))
      g.setEdge(edge.from, edge.to, { id: edge.id })
  dagre.layout(g)

  const positions: Record<string, Point> = {}
  for (const node of graph.nodes) {
    const placed = g.node(node.ref)
    const box = boxes.get(node.ref) ?? TERMINAL
    positions[node.ref] = {
      x: Math.round((placed?.x ?? 0) - box.width / 2),
      y: Math.round((placed?.y ?? 0) - box.height / 2),
    }
  }

  // dagre 的折点绕开了卡片，直接拿来当走线，避免连线穿过节点。
  const routes: Record<string, Point[]> = {}
  for (const edge of graph.edges) {
    if (back.has(edge.id)) continue
    const routed = g.edge(edge.from, edge.to)?.points ?? []
    routes[edge.id] = routed.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) }))
  }

  // 回边统一从底部绕回，多条按顺序错开车道。
  let lane = 0
  const bottom = Math.max(
    ...graph.nodes.map((node) => (positions[node.ref]?.y ?? 0) + (boxes.get(node.ref) ?? TERMINAL).height),
  )
  for (const edge of graph.edges) {
    if (!back.has(edge.id)) continue
    const from = positions[edge.from]
    const to = positions[edge.to]
    if (!from || !to) continue
    const laneY = Math.round(bottom + 28 + lane * LANE_GAP)
    lane += 1
    routes[edge.id] = [
      { x: from.x + (boxes.get(edge.from) ?? TERMINAL).width + 18, y: laneY },
      { x: to.x - 18, y: laneY },
    ]
  }

  return { positions, routes, back }
}

/** 沿折线取指定距离处的点，用于摆放结果标签。 */
export function pointAtDistance(points: Point[], distance: number): Point {
  if (!points.length) return { x: 0, y: 0 }
  let left = distance
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    if (left <= length || i === points.length - 1) {
      const t = length ? Math.min(1, left / length) : 0
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      }
    }
    left -= length
  }
  return points[points.length - 1]
}

/** 沿折线取指定比例处的点，用于摆放结果标签。 */
export function pointAlong(points: Point[], ratio = 0.5): Point {
  if (!points.length) return { x: 0, y: 0 }
  if (points.length === 1) return points[0]
  const lengths: number[] = []
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    lengths.push(length)
    total += length
  }
  let remaining = total * ratio
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] || i === lengths.length - 1) {
      const start = points[i]
      const end = points[i + 1]
      const t = lengths[i] ? Math.min(1, remaining / lengths[i]) : 0
      return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }
    }
    remaining -= lengths[i]
  }
  return points[points.length - 1]
}

/** 把折点画成带圆角的折线，供连线与回边共用。 */
export function roundedPath(points: Point[], radius = 8): string {
  if (points.length < 2) return ''
  const parts = [`M ${points[0].x},${points[0].y}`]
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1]
    const current = points[i]
    const next = points[i + 1]
    const inLength = Math.hypot(current.x - previous.x, current.y - previous.y)
    const outLength = Math.hypot(next.x - current.x, next.y - current.y)
    const bend = Math.min(radius, inLength / 2, outLength / 2)
    if (bend < 0.5) {
      parts.push(`L ${current.x},${current.y}`)
      continue
    }
    const before = {
      x: current.x - ((current.x - previous.x) / inLength) * bend,
      y: current.y - ((current.y - previous.y) / inLength) * bend,
    }
    const after = {
      x: current.x + ((next.x - current.x) / outLength) * bend,
      y: current.y + ((next.y - current.y) / outLength) * bend,
    }
    parts.push(`L ${before.x},${before.y}`, `Q ${current.x},${current.y} ${after.x},${after.y}`)
  }
  const last = points[points.length - 1]
  parts.push(`L ${last.x},${last.y}`)
  return parts.join(' ')
}
