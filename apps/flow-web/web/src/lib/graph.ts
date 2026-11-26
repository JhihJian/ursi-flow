import type { FlowDetail, FlowNodeView } from '../api'

/**
 * 把解析后的 Flow 结构排成一张左到右的分层图。
 * 只做布局计算，不碰 DOM：节点坐标、连线路径与尺寸都由这里给出，
 * 渲染层只负责把结果画成 SVG，测试也只需要断言这份数据。
 */

export type GraphNodeKind = FlowNodeView['kind'] | 'start' | 'finish' | 'parallel'

export interface GraphNode {
  key: string
  label: string
  kind: GraphNodeKind
  /** 层级：从起始节点算起的最长路径层号。 */
  depth: number
  x: number
  y: number
  width: number
  height: number
}

export interface GraphEdge {
  from: string
  to: string
  /** 结果边名；进入并行的分支入口没有结果名。 */
  label?: string
  /** 回边：目标层级不深于来源，用弧线绕开主链。 */
  back: boolean
  path: string
  labelX: number
  labelY: number
}

export interface GraphLayout {
  nodes: GraphNode[]
  edges: GraphEdge[]
  width: number
  height: number
}

const NODE_HEIGHT = 34
const ROW_GAP = 26
const COLUMN_GAP = 68
const PADDING = 12
const MIN_COLUMN = 132
const MAX_COLUMN = 220
const CHAR = 7
const EDGE_LABEL_ROOM = 18

/** 图里的节点名比侧边栏更长，用「序号 · 名称」保证同层宽度可读。 */
function nodeLabel(name: string): string {
  return name.length > 14 ? `${name.slice(0, 13)}…` : name
}

function widthOf(label: string): number {
  return Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, Math.round(label.length * CHAR) + 28))
}

export function layoutFlow(detail: FlowDetail): GraphLayout {
  const nodes = new Map<string, GraphNode>()
  const edges: Array<{ from: string; to: string; label?: string }> = []

  const startKey = 'start'
  nodes.set(startKey, {
    key: startKey,
    label: '开始',
    kind: 'start',
    depth: 0,
    x: 0,
    y: 0,
    width: MIN_COLUMN,
    height: NODE_HEIGHT,
  })

  for (const node of detail.nodes) {
    nodes.set(node.ref, {
      key: node.ref,
      label: nodeLabel(node.name),
      kind: node.kind,
      depth: 1,
      x: 0,
      y: 0,
      width: widthOf(nodeLabel(node.name)),
      height: NODE_HEIGHT,
    })
  }

  let finishAdded = false
  const ensureFinish = () => {
    if (finishAdded) return 'finish'
    finishAdded = true
    nodes.set('finish', {
      key: 'finish',
      label: '结束',
      kind: 'finish',
      depth: 1,
      x: 0,
      y: 0,
      width: MIN_COLUMN,
      height: NODE_HEIGHT,
    })
    return 'finish'
  }

  if (detail.startNodeRef !== '') edges.push({ from: startKey, to: detail.startNodeRef })

  for (const node of detail.nodes) {
    for (const outcome of node.outcomes) {
      if (outcome.destination.kind === 'node' && outcome.destination.ref !== undefined)
        edges.push({ from: node.ref, to: outcome.destination.ref, label: outcome.name })
      else if (outcome.destination.kind === 'parallel' && outcome.destination.ref !== undefined)
        edges.push({
          from: node.ref,
          to: `parallel:${outcome.destination.ref}`,
          label: outcome.name,
        })
      else
        edges.push({ from: node.ref, to: ensureFinish(), label: outcome.name })
    }
  }

  // 并行开始点作为独立节点，分支入口没有结果名，出口沿用分支节点自己的结果边。
  for (const parallel of detail.parallels) {
    const key = `parallel:${parallel.ref}`
    nodes.set(key, {
      key,
      label: `并行 · ${parallel.branches.length} 支`,
      kind: 'parallel',
      depth: 1,
      x: 0,
      y: 0,
      width: widthOf(`并行 · ${parallel.branches.length} 支`),
      height: NODE_HEIGHT,
    })
    for (const branch of parallel.branches) edges.push({ from: key, to: branch })
  }

  assignDepths(nodes, edges)
  const geometry = place(nodes, edges)
  return geometry
}

/**
 * 最长路径分层。先用深度优先找出回边，再只在前进边上做松弛：
 * 否则环会让层级来回加，图被推平。
 */
function assignDepths(
  nodes: Map<string, GraphNode>,
  edges: Array<{ from: string; to: string }>,
): void {
  const next = new Map<string, string[]>()
  for (const edge of edges) {
    const list = next.get(edge.from) ?? []
    list.push(edge.to)
    next.set(edge.from, list)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const back = new Set<string>()
  const walk = (key: string): void => {
    if (visiting.has(key) || visited.has(key)) return
    visiting.add(key)
    for (const to of next.get(key) ?? []) {
      if (visiting.has(to)) {
        back.add(`${key}->${to}`)
        continue
      }
      walk(to)
    }
    visiting.delete(key)
    visited.add(key)
  }
  for (const key of nodes.keys()) walk(key)

  const forward = edges.filter((edge) => !back.has(`${edge.from}->${edge.to}`))
  for (let round = 0; round < nodes.size + 1; round += 1) {
    let changed = false
    for (const edge of forward) {
      const from = nodes.get(edge.from)
      const to = nodes.get(edge.to)
      if (from === undefined || to === undefined || to.key === 'start') continue
      const candidate = from.depth + 1
      if (candidate > to.depth) {
        to.depth = candidate
        changed = true
      }
    }
    if (!changed) break
  }
  // 没接上起始节点的孤立节点统一放到第一层，仍然可见。
  for (const node of nodes.values()) if (node.key !== 'start' && node.depth < 1) node.depth = 1
}

function place(
  nodes: Map<string, GraphNode>,
  rawEdges: Array<{ from: string; to: string; label?: string }>,
): GraphLayout {
  const byDepth = new Map<number, GraphNode[]>()
  for (const node of nodes.values()) {
    const row = byDepth.get(node.depth) ?? []
    row.push(node)
    byDepth.set(node.depth, row)
  }
  const depths = [...byDepth.keys()].sort((left, right) => left - right)
  const columnWidths = depths.map((depth) =>
    Math.max(...byDepth.get(depth)!.map((node) => node.width)),
  )
  const xOf = new Map<number, number>()
  let x = PADDING
  depths.forEach((depth, index) => {
    xOf.set(depth, x)
    x += columnWidths[index] + COLUMN_GAP
  })

  const tallest = Math.max(...depths.map((depth) => byDepth.get(depth)!.length))
  const height = PADDING * 2 + tallest * NODE_HEIGHT + Math.max(0, tallest - 1) * ROW_GAP
  for (const depth of depths) {
    const row = byDepth.get(depth)!
    const stack = row.length * NODE_HEIGHT + Math.max(0, row.length - 1) * ROW_GAP
    let y = PADDING + Math.max(0, (height - PADDING * 2 - stack) / 2)
    for (const node of row) {
      node.x = xOf.get(depth)!
      node.y = y
      y += NODE_HEIGHT + ROW_GAP
    }
  }

  const edges: GraphEdge[] = []
  for (const edge of rawEdges) {
    const from = nodes.get(edge.from)
    const to = nodes.get(edge.to)
    if (from === undefined || to === undefined) continue
    const back = to.depth <= from.depth
    const geometry = from.depth === to.depth ? 'same' : back ? 'back' : 'forward'
    const path = edgePath(from, to, geometry)
    const label = edge.label
    edges.push({
      from: from.key,
      to: to.key,
      ...(label === undefined ? {} : { label }),
      back,
      path,
      labelX: label === undefined ? 0 : (from.x + from.width + to.x) / 2,
      labelY:
        label === undefined
          ? 0
          : geometry === 'same'
            ? Math.max(from.y, to.y) - 4
            : Math.min(from.y, to.y) + NODE_HEIGHT / 2 - EDGE_LABEL_ROOM / 2,
    })
  }

  const width = Math.max(...edges.map((edge) => edge.labelX), 0) + PADDING
  return {
    nodes: [...nodes.values()],
    edges,
    width: Math.max(width, x - COLUMN_GAP + PADDING),
    height: height + EDGE_LABEL_ROOM,
  }
}

function edgePath(
  from: GraphNode,
  to: GraphNode,
  geometry: 'forward' | 'back' | 'same',
): string {
  const x1 = from.x + from.width
  const y1 = from.y + NODE_HEIGHT / 2
  const x2 = to.x
  const y2 = to.y + NODE_HEIGHT / 2
  if (geometry === 'forward') {
    const mid = (x1 + x2) / 2
    return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
  }
  if (geometry === 'same') {
    const midY = Math.max(from.y, to.y) + NODE_HEIGHT + ROW_GAP / 2
    return `M ${x1} ${y1} C ${x1 + 30} ${midY}, ${x2 - 30} ${midY}, ${x2} ${y2}`
  }
  // 回边从右侧绕到目标下方，避免覆盖主链；落到目标底部而不是左侧。
  const bottom = Math.max(...[from.y, to.y]) + NODE_HEIGHT
  const exitX = x1 + 24
  const entryX = to.x + to.width / 2
  return `M ${x1} ${y1} C ${exitX} ${y1}, ${exitX} ${bottom + 26}, ${entryX} ${bottom + 26} L ${entryX} ${to.y + NODE_HEIGHT}`
}
