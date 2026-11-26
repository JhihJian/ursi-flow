import type { FlowDetail, FlowNodeView } from '../api'

/**
 * 把解析后的 Flow 结构排成一张从上到下的分层图。
 * 只做布局计算，不碰 DOM：节点坐标、连线路径、标签位置与尺寸都由这里给出，
 * 渲染层只负责把结果画成 SVG。
 *
 * 走线规则：
 * - 相邻层的正向边走两层之间的空白走廊，每条边一条水平车道，标签压在车道上；
 * - 回到前面节点的回边走左侧留白，跨多层的正向边走右侧留白，标签贴在各自车道旁；
 * - 自环画在节点右侧。三类线不抢同一条路径，标签就不会互相遮挡。
 */

export type GraphNodeKind = FlowNodeView['kind'] | 'start' | 'finish' | 'parallel'

export interface GraphNode {
  key: string
  label: string
  kind: GraphNodeKind
  /** 层级：从起始节点算起的最长路径层号，决定上下位置。 */
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
  /** 回边或跨层边：目标层级不深于来源，用侧边车道绕行。 */
  back: boolean
  path: string
  labelX: number
  labelY: number
  labelWidth: number
  labelHeight: number
  labelAnchor: 'start' | 'middle' | 'end'
}

export interface GraphLayout {
  nodes: GraphNode[]
  edges: GraphEdge[]
  width: number
  height: number
}

const NODE_HEIGHT = 34
const NODE_GAP = 26
const PAD = 16
const MIN_COLUMN = 124
const MAX_COLUMN = 200
const CHAR = 7
const LABEL_HEIGHT = 13
const LABEL_CHAR = 5
const LANE_HEIGHT = 16
const CORRIDOR_HEAD = 16
const CORRIDOR_TAIL = 8
const SIDE_LABEL_GAP = 8
const SIDE_LANE_GAP = 14

/** 图里的节点名比侧边栏更长，用「名称」截断保证同层宽度可读。 */
function nodeLabel(name: string): string {
  return name.length > 14 ? `${name.slice(0, 13)}…` : name
}

function boxWidth(label: string): number {
  return Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, Math.round(label.length * CHAR) + 28))
}

/**
 * 边标签用 10px 等宽字体：中文按一个字宽、拉丁字母按半宽估算，
 * 低估宽度会让左侧车道的标签被画布边缘裁掉。
 */
function labelWidth(text: string): number {
  let width = 0
  for (const char of text) width += CJK.test(char) ? LABEL_CHAR * 2 : LABEL_CHAR
  return Math.round(width) + 6
}

const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFF60\u3000-\u303F]/

interface RawEdge {
  from: string
  to: string
  label?: string
}

export function layoutFlow(detail: FlowDetail): GraphLayout {
  const nodes = new Map<string, GraphNode>()
  const rawEdges: RawEdge[] = []
  const addNode = (
    key: string,
    label: string,
    kind: GraphNodeKind,
    width = boxWidth(label),
  ) => {
    nodes.set(key, {
      key,
      label,
      kind,
      depth: 0,
      x: 0,
      y: 0,
      width,
      height: NODE_HEIGHT,
    })
  }

  addNode('start', '开始', 'start')
  for (const node of detail.nodes) addNode(node.ref, nodeLabel(node.name), node.kind)

  let finishAdded = false
  const finishKey = () => {
    if (!finishAdded) {
      finishAdded = true
      addNode('finish', '结束', 'finish')
    }
    return 'finish'
  }

  if (detail.startNodeRef !== '') rawEdges.push({ from: 'start', to: detail.startNodeRef })

  for (const node of detail.nodes) {
    for (const outcome of node.outcomes) {
      const destination = outcome.destination
      if (destination.kind === 'node' && destination.ref !== undefined)
        rawEdges.push({ from: node.ref, to: destination.ref, label: outcome.name })
      else if (destination.kind === 'parallel' && destination.ref !== undefined)
        rawEdges.push({
          from: node.ref,
          to: `parallel:${destination.ref}`,
          label: outcome.name,
        })
      else rawEdges.push({ from: node.ref, to: finishKey(), label: outcome.name })
    }
  }

  for (const parallel of detail.parallels) {
    const key = `parallel:${parallel.ref}`
    addNode(key, `并行 · ${parallel.branches.length} 支`, 'parallel')
    for (const branch of parallel.branches) rawEdges.push({ from: key, to: branch })
  }

  assignDepths(nodes, rawEdges)
  return place(nodes, rawEdges)
}

/** 最长路径分层。先找出回边，再只在前进边上松弛，避免环把层级越推越深。 */
function assignDepths(nodes: Map<string, GraphNode>, edges: RawEdge[]): void {
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
  for (const node of nodes.values()) if (node.key !== 'start' && node.depth < 1) node.depth = 1
}

function place(nodes: Map<string, GraphNode>, rawEdges: RawEdge[]): GraphLayout {
  const byDepth = new Map<number, GraphNode[]>()
  for (const node of nodes.values()) {
    const row = byDepth.get(node.depth) ?? []
    row.push(node)
    byDepth.set(node.depth, row)
  }
  const depths = [...byDepth.keys()].sort((left, right) => left - right)
  const rows = depths.map((depth) => byDepth.get(depth)!)

  const resolved = rawEdges
    .map((edge) => ({
      edge,
      from: nodes.get(edge.from),
      to: nodes.get(edge.to),
    }))
    .filter(
      (item): item is { edge: RawEdge; from: GraphNode; to: GraphNode } =>
        item.from !== undefined && item.to !== undefined,
    )

  const selfEdges = resolved.filter(({ from, to }) => from === to)
  const backEdges = resolved.filter(
    ({ from, to }) => from !== to && to.depth <= from.depth,
  )
  const forwardEdges = resolved.filter(({ from, to }) => from !== to && to.depth > from.depth)
  const corridorOf = (depth: number) =>
    forwardEdges.filter(({ from, to }) => from.depth === depth && to.depth === depth + 1)
  const skipEdges = forwardEdges.filter(({ from, to }) => to.depth > from.depth + 1)

  // 侧边走线只用一条车道：标签沿各自运行的起点错开高度，留白只按最宽标签计算。
  const backLabelWidth = Math.max(
    0,
    ...backEdges.map((item) => labelWidth(item.edge.label ?? '')),
  )
  const skipLabelWidth = Math.max(
    0,
    ...skipEdges.map((item) => labelWidth(item.edge.label ?? '')),
  )
  const leftMargin = backLabelWidth === 0 ? PAD : PAD + backLabelWidth + 16
  const rightMargin = skipLabelWidth === 0 ? PAD : skipLabelWidth + SIDE_LANE_GAP + 12

  // 行宽决定内容区宽度；每行水平居中。
  const rowWidths = rows.map(
    (row) => row.reduce((total, node) => total + node.width, 0) + NODE_GAP * Math.max(0, row.length - 1),
  )
  const contentWidth = Math.max(...rowWidths)

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const left = leftMargin + (contentWidth - rowWidths[index]) / 2
    let x = left
    for (const node of row) {
      node.x = x
      x += node.width + NODE_GAP
    }
  }

  // 行高：节点高度 + 这一层向下一层走边所需的走廊高度。
  const corridorY = new Map<string, number>()
  let y = PAD
  const rowTops: number[] = []
  for (let index = 0; index < rows.length; index += 1) {
    rowTops.push(y)
    for (const node of rows[index]) node.y = y
    const lanes = [...corridorOf(depths[index])].sort(
      (left, right) =>
        left.to.x - right.to.x || left.from.x - right.from.x,
    )
    const bottom = y + NODE_HEIGHT
    lanes.forEach((item, laneIndex) => {
      corridorY.set(`${item.edge.from}->${item.edge.to}`, bottom + CORRIDOR_HEAD + laneIndex * LANE_HEIGHT)
    })
    const gap = index === rows.length - 1
      ? 0
      : lanes.length === 0
        ? 24
        : CORRIDOR_HEAD + lanes.length * LANE_HEIGHT + CORRIDOR_TAIL
    y = bottom + gap
  }
  const height = y + PAD

  const width = leftMargin + contentWidth + rightMargin
  const edges: GraphEdge[] = []
  const backIndex = staggerIndex(backEdges)
  const skipIndex = staggerIndex(skipEdges)

  const pushEdge = (
    item: (typeof resolved)[number],
    path: string,
    label: {
      x: number
      y: number
      anchor: GraphEdge['labelAnchor']
    },
  ) => {
    const text = item.edge.label
    edges.push({
      from: item.from.key,
      to: item.to.key,
      ...(text === undefined ? {} : { label: text }),
      back: item.to.depth <= item.from.depth,
      path,
      labelX: label.x,
      labelY: label.y,
      labelWidth: text === undefined ? 0 : labelWidth(text),
      labelHeight: LABEL_HEIGHT,
      labelAnchor: label.anchor,
    })
  }

  /** 同一起点的多条侧边标签依次下移，避免压在一起。 */
  function staggerIndex(items: Array<{ from: GraphNode }>): Map<unknown, number> {
    const seen = new Map<string, number>()
    const index = new Map<unknown, number>()
    for (const item of items) {
      const count = seen.get(item.from.key) ?? 0
      index.set(item, count)
      seen.set(item.from.key, count + 1)
    }
    return index
  }

  function sideLabelY(from: GraphNode, offset: number): number {
    return from.y + NODE_HEIGHT / 2 - LABEL_HEIGHT / 2 + offset * LANE_HEIGHT
  }

  /** 走廊标签夹在内容区内，避免压到两侧车道上的标签。 */
  function corridorLabel(
    x1: number,
    x2: number,
    textWidth: number,
    laneY: number,
    contentLeft: number,
    contentRight: number,
  ): { x: number; y: number; anchor: GraphEdge['labelAnchor'] } {
    const y = laneY - LABEL_HEIGHT - 2
    if (Math.abs(x2 - x1) < 12) return { x: x1 + 4, y, anchor: 'start' }
    const center = (x1 + x2) / 2
    const left = contentLeft + 2
    const right = contentRight - 2
    if (right - left < textWidth) return { x: left, y, anchor: 'start' }
    return {
      x: Math.min(Math.max(center, left + textWidth / 2), right - textWidth / 2),
      y,
      anchor: 'middle',
    }
  }

  for (const item of forwardEdges) {
    const { from, to } = item
    const x1 = from.x + from.width / 2
    const y1 = from.y + NODE_HEIGHT
    const x2 = to.x + to.width / 2
    const y2 = to.y
    if (to.depth === from.depth + 1) {
      const laneY = corridorY.get(`${from.key}->${to.key}`) ?? y1 + CORRIDOR_HEAD
      const textWidth = labelWidth(item.edge.label ?? '')
      pushEdge(
        item,
        `M ${x1} ${y1} L ${x1} ${laneY} L ${x2} ${laneY} L ${x2} ${y2}`,
        corridorLabel(x1, x2, textWidth, laneY, leftMargin, leftMargin + contentWidth),
      )
      continue
    }
    // 跨层正向边：走右侧留白车道，标签按来源节点错开高度。
    const laneX = width - rightMargin + SIDE_LANE_GAP
    pushEdge(
      item,
      `M ${from.x + from.width} ${from.y + NODE_HEIGHT / 2} L ${laneX} ${from.y + NODE_HEIGHT / 2} L ${laneX} ${to.y + NODE_HEIGHT / 2} L ${to.x + to.width} ${to.y + NODE_HEIGHT / 2}`,
      {
        x: laneX + SIDE_LABEL_GAP,
        y: sideLabelY(from, skipIndex.get(item) ?? 0),
        anchor: 'start',
      },
    )
  }

  const laneX = leftMargin - 10
  for (const item of backEdges) {
    const { from, to } = item
    const y1 = from.y + NODE_HEIGHT / 2
    const y2 = to.y + NODE_HEIGHT / 2
    pushEdge(
      item,
      `M ${from.x} ${y1} L ${laneX} ${y1} L ${laneX} ${y2} L ${to.x} ${y2}`,
      {
        x: laneX - SIDE_LABEL_GAP,
        y: sideLabelY(from, backIndex.get(item) ?? 0),
        anchor: 'end',
      },
    )
  }

  for (const item of selfEdges) {
    const { from } = item
    const y1 = from.y + 10
    const y2 = from.y + NODE_HEIGHT - 8
    const loopX = from.x + from.width + 18
    pushEdge(
      item,
      `M ${from.x + from.width} ${y1} L ${loopX} ${y1} L ${loopX} ${y2} L ${from.x + from.width} ${y2}`,
      {
        x: loopX + SIDE_LABEL_GAP,
        y: (y1 + y2) / 2 - LABEL_HEIGHT / 2,
        anchor: 'start',
      },
    )
  }

  return { nodes: [...nodes.values()], edges, width, height }
}
