import type { FlowDetail, FlowNodeView } from '../api'

/**
 * 把解析后的 Flow 结构排成一张从上到下的分层图。
 * 只做布局计算，不碰 DOM：节点坐标、连线路径、标签位置与尺寸都由这里给出，
 * 渲染层只负责把结果画成 SVG。
 *
 * 走线与标签规则（目标是任意两条边不重合、任何标签不压线）：
 * - 相邻层正向边：走两层之间的空白走廊，每条边一条水平车道；
 * - 回边（目标在当前节点上方）：走左侧留白，每条边一条竖车道；
 * - 跨层正向边（中间还有别的层）：走右侧留白，每条边一条竖车道；
 * - 同一节点上的多条出边或入边会在节点边上错开成不同端口，短竖段/横段不重叠；
 * - 标签统一放在留白最外侧的一列，压在自己那条边的出口横段上方，
 *   留白按车道数与最宽标签算，因此标签既不会互相遮挡，也不会盖住任何一条线。
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
  /** 回边或跨层边：目标层级不深于来源。 */
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
const SIDE_LANE_STEP = 10
const SIDE_LABEL_GAP = 8
const SELF_LOOP_WIDTH = 18

/** 图里的节点名比侧边栏更长，用「名称」截断保证同层宽度可读。 */
function nodeLabel(name: string): string {
  return name.length > 14 ? `${name.slice(0, 13)}…` : name
}

function boxWidth(label: string): number {
  return Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, Math.round(label.length * CHAR) + 28))
}

const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFF60\u3000-\u303F]/

/**
 * 边标签用 10px 等宽字体：中文按一个字宽、拉丁字母按半宽估算，
 * 低估宽度会让留白不足，标签被画布边缘裁掉。
 */
function labelWidth(text: string): number {
  let width = 0
  for (const char of text) width += CJK.test(char) ? LABEL_CHAR * 2 : LABEL_CHAR
  return Math.round(width) + 6
}

interface RawEdge {
  from: string
  to: string
  label?: string
}

interface ResolvedEdge {
  edge: RawEdge
  from: GraphNode
  to: GraphNode
}

export function layoutFlow(detail: FlowDetail): GraphLayout {
  const nodes = new Map<string, GraphNode>()
  const rawEdges: RawEdge[] = []
  const addNode = (key: string, label: string, kind: GraphNodeKind) => {
    nodes.set(key, {
      key,
      label,
      kind,
      depth: 0,
      x: 0,
      y: 0,
      width: boxWidth(label),
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
    addNode(`parallel:${parallel.ref}`, `并行 · ${parallel.branches.length} 支`, 'parallel')
    for (const branch of parallel.branches)
      rawEdges.push({ from: `parallel:${parallel.ref}`, to: branch })
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

  const resolved: ResolvedEdge[] = rawEdges
    .map((edge) => ({ edge, from: nodes.get(edge.from), to: nodes.get(edge.to) }))
    .filter((item): item is ResolvedEdge => item.from !== undefined && item.to !== undefined)

  const selfEdges = resolved.filter(({ from, to }) => from === to)
  const backEdges = resolved.filter(({ from, to }) => from !== to && to.depth <= from.depth)
  const forwardEdges = resolved.filter(({ from, to }) => from !== to && to.depth > from.depth)
  const corridorEdges = forwardEdges.filter(({ from, to }) => to.depth === from.depth + 1)
  const skipEdges = forwardEdges.filter(({ from, to }) => to.depth > from.depth + 1)

  // 侧边车道：每条边一条竖线，越靠内越靠近内容；标签统一放在最外侧一列。
  const backLane = laneOffsets(backEdges)
  const skipLane = laneOffsets(skipEdges)
  const backSpan = Math.max(0, (backEdges.length - 1) * SIDE_LANE_STEP)
  const skipSpan = Math.max(0, (skipEdges.length - 1) * SIDE_LANE_STEP)
  const backLabelWidth = Math.max(0, ...backEdges.map((item) => labelWidth(item.edge.label ?? '')))
  const skipLabelWidth = Math.max(0, ...skipEdges.map((item) => labelWidth(item.edge.label ?? '')))
  const leftMargin =
    backEdges.length === 0 ? PAD : PAD + backSpan + SIDE_LABEL_GAP + backLabelWidth + 8
  const rightMargin =
    skipEdges.length === 0 ? PAD : PAD + skipSpan + SIDE_LABEL_GAP + skipLabelWidth + 8

  // 行宽决定内容区宽度；每行水平居中。
  const rowWidths = rows.map(
    (row) =>
      row.reduce((total, node) => total + node.width, 0) + NODE_GAP * Math.max(0, row.length - 1),
  )
  const contentWidth = Math.max(...rowWidths)

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    let x = leftMargin + (contentWidth - rowWidths[index]) / 2
    for (const node of row) {
      node.x = x
      x += node.width + NODE_GAP
    }
  }

  // 行高：节点高度 + 这一层向下一层走边所需的走廊高度。
  const corridorY = new Map<string, number>()
  let y = PAD
  for (let index = 0; index < rows.length; index += 1) {
    for (const node of rows[index]) node.y = y
    const lanes = corridorEdges
      .filter(({ from }) => from.depth === depths[index])
      .sort((left, right) => left.to.x - right.to.x || left.from.x - right.from.x)
    const bottom = y + NODE_HEIGHT
    lanes.forEach((item, laneIndex) => {
      corridorY.set(`${item.from.key}->${item.to.key}`, bottom + CORRIDOR_HEAD + laneIndex * LANE_HEIGHT)
    })
    const gap =
      index === rows.length - 1
        ? 0
        : lanes.length === 0
          ? 24
          : CORRIDOR_HEAD + lanes.length * LANE_HEIGHT + CORRIDOR_TAIL
    y = bottom + gap
  }
  const height = y + PAD
  const width = leftMargin + contentWidth + rightMargin
  const contentRight = leftMargin + contentWidth

  const edges: GraphEdge[] = []
  const pushEdge = (
    item: ResolvedEdge,
    path: string,
    label: { x: number; y: number; anchor: GraphEdge['labelAnchor'] },
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

  // 端口：同一组边上同一条边不共用同一个出点或入点，短线段因此不会重叠。
  const bottomOut = ports(corridorEdges, (item) => item.from, 'width')
  const topIn = ports(corridorEdges, (item) => item.to, 'width')
  const leftSide = sidePorts(backEdges)
  const rightLabelEdges = [...skipEdges, ...selfEdges]
  const rightSide = sidePorts([...skipEdges, ...selfEdges])
  const rightOut = rightSide.exit
  const rightIn = rightSide.entry
  const rightLabelX = contentRight + skipSpan + SIDE_LABEL_GAP
  const leftLabelY = labelSlots(backEdges, (item) => item.from.y + leftSide.exit.get(item)!)
  const rightLabelY = labelSlots(
    rightLabelEdges,
    (item) => item.from.y + rightOut.get(item)!,
  )

  for (const item of forwardEdges) {
    const { from, to } = item
    if (to.depth === from.depth + 1) {
      const x1 = from.x + bottomOut.get(item)!
      const y1 = from.y + NODE_HEIGHT
      const x2 = to.x + topIn.get(item)!
      const y2 = to.y
      const laneY = corridorY.get(`${from.key}->${to.key}`) ?? y1 + CORRIDOR_HEAD
      const textWidth = labelWidth(item.edge.label ?? '')
      pushEdge(
        item,
        `M ${x1} ${y1} L ${x1} ${laneY} L ${x2} ${laneY} L ${x2} ${y2}`,
        corridorLabel(x1, x2, textWidth, laneY, leftMargin, contentRight),
      )
      continue
    }
    // 跨层正向边：右侧留白，出口横段在端口高度，标签压在这段上方。
    const laneX = contentRight + skipLane.get(item)!
    const y1 = from.y + rightOut.get(item)!
    const y2 = to.y + rightIn.get(item)!
    pushEdge(
      item,
      `M ${from.x + from.width} ${y1} L ${laneX} ${y1} L ${laneX} ${y2} L ${to.x + to.width} ${y2}`,
      {
        x: rightLabelX,
        y: rightLabelY.get(item)!,
        anchor: 'start',
      },
    )
  }

  const skipLanes = skipEdges.map((item) => ({
    x: contentRight + skipLane.get(item)!,
    from: item.from.y + rightOut.get(item)!,
    to: item.to.y + rightIn.get(item)!,
  }))

  for (const item of selfEdges) {
    const { from } = item
    const y1 = from.y + Math.min(NODE_HEIGHT - 16, rightOut.get(item)!)
    const y2 = y1 + 12
    const loopX = from.x + from.width + SELF_LOOP_WIDTH
    // 自环标签优先贴在环旁边；只有右侧车道会压到它时才退到最外侧标签列。
    const labelY = (y1 + y2) / 2 - LABEL_HEIGHT / 2
    const nearX = loopX + 6
    const textWidth = labelWidth(item.edge.label ?? '')
    const crossed = skipLanes.some(
      (lane) =>
        lane.x >= nearX - 2 &&
        lane.x <= nearX + textWidth + 2 &&
        lane.from < labelY + LABEL_HEIGHT &&
        labelY < lane.to,
    )
    pushEdge(
      item,
      `M ${from.x + from.width} ${y1} L ${loopX} ${y1} L ${loopX} ${y2} L ${from.x + from.width} ${y2}`,
      crossed
        ? { x: rightLabelX, y: rightLabelY.get(item)!, anchor: 'start' }
        : { x: nearX, y: labelY, anchor: 'start' },
    )
  }

  for (const item of backEdges) {
    const { from, to } = item
    const laneX = leftMargin - backLane.get(item)!
    const y1 = from.y + leftSide.exit.get(item)!
    const y2 = to.y + leftSide.entry.get(item)!
    pushEdge(
      item,
      `M ${from.x} ${y1} L ${laneX} ${y1} L ${laneX} ${y2} L ${to.x} ${y2}`,
      {
        x: leftMargin - backSpan - SIDE_LABEL_GAP,
        y: leftLabelY.get(item)!,
        anchor: 'end',
      },
    )
  }

  return { nodes: [...nodes.values()], edges, width, height }
}

/** 每条侧边在留白里的车道序号；按目标远近排序，近的放内侧。 */
function laneOffsets(items: ResolvedEdge[]): Map<ResolvedEdge, number> {
  const ordered = [...items].sort(
    (left, right) =>
      left.to.depth - right.to.depth || left.from.depth - right.from.depth || 0,
  )
  return new Map(ordered.map((item, index) => [item, index * SIDE_LANE_STEP]))
}

/** 同一节点上的多条边沿这条边错开：返回相对节点左上角的偏移。 */
function ports(
  items: ResolvedEdge[],
  node: (item: ResolvedEdge) => GraphNode,
  axis: 'width' | 'height',
): Map<ResolvedEdge, number> {
  const groups = new Map<string, ResolvedEdge[]>()
  for (const item of items) {
    const key = node(item).key
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  const result = new Map<ResolvedEdge, number>()
  for (const group of groups.values()) {
    group.forEach((item, index) => {
      const size = axis === 'width' ? node(item).width : node(item).height
      result.set(item, (size * (index + 1)) / (group.length + 1))
    })
  }
  return result
}

/**
 * 同一节点同一侧的出边与进边统一编号：
 * 如果分开编号，一出一进会在节点边上落到同一个高度，两条横段就重合了。
 */
function sidePorts(items: ResolvedEdge[]): {
  exit: Map<ResolvedEdge, number>
  entry: Map<ResolvedEdge, number>
} {
  const groups = new Map<string, Array<{ item: ResolvedEdge; role: 'exit' | 'entry' }>>()
  const add = (node: GraphNode, item: ResolvedEdge, role: 'exit' | 'entry') => {
    const group = groups.get(node.key) ?? []
    group.push({ item, role })
    groups.set(node.key, group)
  }
  for (const item of items) {
    add(item.from, item, 'exit')
    add(item.to, item, 'entry')
  }
  const exit = new Map<ResolvedEdge, number>()
  const entry = new Map<ResolvedEdge, number>()
  for (const group of groups.values()) {
    const height = group[0].item.from.height
    group.forEach(({ item, role }, index) => {
      const offset = (height * (index + 1)) / (group.length + 1)
      if (role === 'exit') exit.set(item, offset)
      else entry.set(item, offset)
    })
  }
  return { exit, entry }
}

/**
 * 同一节点的多条侧边共享一列标签：按出口高度排序后紧挨着排成一摞，
 * 整体以出口高度的中点为心，保证标签之间有间距、又不离自己的边太远。
 */
function labelSlots(
  items: ResolvedEdge[],
  portY: (item: ResolvedEdge) => number,
): Map<ResolvedEdge, number> {
  const groups = new Map<string, ResolvedEdge[]>()
  for (const item of items) {
    const group = groups.get(item.from.key) ?? []
    group.push(item)
    groups.set(item.from.key, group)
  }
  const slots = new Map<ResolvedEdge, number>()
  const step = LABEL_HEIGHT + 2
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => portY(left) - portY(right))
    const center =
      ordered.reduce((total, item) => total + portY(item), 0) / ordered.length
    const start = center - (ordered.length * step - 2) / 2
    ordered.forEach((item, index) => slots.set(item, start + index * step))
  }
  return slots
}

/** 走廊标签夹在内容区内，避免压到两侧留白里的车道。 */
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
