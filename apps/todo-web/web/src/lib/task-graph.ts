import type { Priority, Task, TaskStatus } from '@/api/types'
import type { GraphPositions } from './graph-positions'

/**
 * 把当前项目的任务排成一张从左到右的关系图。
 * 这里只算节点、连线与坐标，不碰 DOM，渲染层把结果画成节点与 SVG 路径。
 *
 * 两种关系分开表示：`parent_id` 变成嵌套的分组节点，`pre_id` 画成前置依赖连线。
 */

export type TaskGraphEdgeKind = 'parent' | 'pre'

export interface TaskGraphNode {
  id: string
  title: string
  label: string
  status: TaskStatus
  priority: Priority
  /** 层级：只由前置依赖决定，分组的子节点跟随父节点摆放。 */
  depth: number
  /** 排序用的创建与更新时间，兄弟任务按更新时间从旧到新排列。 */
  createdAt: string
  updatedAt: string | null
  /** 节点自身标题条的绝对坐标。 */
  x: number
  y: number
  /** 节点整体尺寸：分组节点包含所有子节点。 */
  width: number
  height: number
  /** 标题条高度，连线与命中都用这条。 */
  headerHeight: number
  /** 可见的父任务；父子关系已经变成嵌套，不再画线。 */
  parentId: string | null
  childIds: string[]
}

export interface TaskGraphEdge {
  from: string
  to: string
  /** 回边：目标层级不深于来源，绕到下方避免压住主链。 */
  back: boolean
  path: string
}

export interface TaskGraphLayout {
  nodes: TaskGraphNode[]
  /** 根节点 id，按层级从左到右排列。 */
  roots: string[]
  edges: TaskGraphEdge[]
  width: number
  height: number
  /** 因为已完成或已取消而省略的任务数。 */
  hidden: number
}

/** 节点宽度固定，标题过长时由 CSS 截断，不用文字长度撑大节点。 */
const NODE_WIDTH = 200
const HEADER_HEIGHT = 40
/** 分组节点里子节点之间的纵向间距；相邻兄弟的前置竖线画在这里，不能太窄。 */
const CHILD_GAP = 28
/** 子节点相对父节点左边的缩进。 */
const CHILD_INDENT = 18
/** 子节点与分组底边的留白。 */
const GROUP_PAD = 16
const COLUMN_GAP = 96
/** 同一列里不相关的根节点之间的间距，比组内子任务更松。 */
const ROOT_GAP = 24
const PADDING = 24
/** 回边绕到节点下方，底线之外要留出的空间。 */
const BACK_EDGE_ROOM = 32
/** 连线终点离节点边框的距离，给箭头留出可见空间。 */
const ARROW_GAP = 8

const STATUS_RANK: Record<TaskStatus, number> = {
  in_progress: 0,
  blocked: 1,
  pending: 2,
  done: 3,
  cancelled: 4,
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 }

/** 未结束的任务：待办、进行中与阻塞都还要在图上出现。 */
export function isOpenTask(task: Task): boolean {
  return task.status !== 'done' && task.status !== 'cancelled'
}

/**
 * 默认只画未结束的任务。已完成或已取消的任务只在直接挂到未结束任务上时保留：
 * 否则完成一个前置任务后，后续任务的来龙去脉就从图里消失了。
 * 只认直接相邻的一层，避免顺着已结束任务把整条历史链拖进图里。
 */
export function buildTaskGraph(
  tasks: Task[],
  positions: GraphPositions = {},
): TaskGraphLayout {
  const open = tasks.filter(isOpenTask)
  const openIds = new Set(open.map((task) => task.id))
  const keep = new Set(openIds)

  for (const task of tasks) {
    if (openIds.has(task.id)) continue
    if (task.parent_id && openIds.has(task.parent_id)) keep.add(task.id)
    if (task.pre_id && openIds.has(task.pre_id)) keep.add(task.id)
  }
  for (const task of open) {
    if (task.parent_id) keep.add(task.parent_id)
    if (task.pre_id) keep.add(task.pre_id)
  }

  const shown = tasks.filter((task) => keep.has(task.id))
  if (shown.length === 0) {
    return { nodes: [], roots: [], edges: [], width: 0, height: 0, hidden: tasks.length }
  }
  const visible = new Set(shown.map((task) => task.id))
  const ids = shown.map((task) => task.id)

  // 父子关系变成嵌套：先取可见父节点，父子成环时在重复处断开，避免无限嵌套。
  const parentOf = new Map<string, string | null>()
  for (const task of shown) {
    const parent = task.parent_id
    parentOf.set(task.id, parent && visible.has(parent) && parent !== task.id ? parent : null)
  }
  for (const id of ids) {
    const seen = new Set<string>()
    let current: string | null = id
    while (current) {
      if (seen.has(current)) {
        parentOf.set(current, null)
        break
      }
      seen.add(current)
      current = parentOf.get(current) ?? null
    }
  }

  const childrenOf = new Map<string, string[]>()
  for (const id of ids) childrenOf.set(id, [])
  const roots: string[] = []
  for (const id of ids) {
    const parent = parentOf.get(id) ?? null
    if (parent) childrenOf.get(parent)!.push(id)
    else roots.push(id)
  }

  const preOf = new Map<string, string | null>()
  for (const task of shown) {
    const pre = task.pre_id
    preOf.set(task.id, pre && visible.has(pre) && pre !== task.id ? pre : null)
  }

  const nodes = new Map<string, TaskGraphNode>()
  for (const task of shown) {
    nodes.set(task.id, {
      id: task.id,
      title: task.title,
      label: task.title.trim(),
      status: task.status,
      priority: task.priority,
      depth: 0,
      createdAt: task.created_at,
      updatedAt: task.updated_at ?? null,
      x: 0,
      y: 0,
      width: NODE_WIDTH,
      height: HEADER_HEIGHT,
      headerHeight: HEADER_HEIGHT,
      parentId: parentOf.get(task.id) ?? null,
      childIds: [],
    })
  }
  const compareIds = (left: string, right: string) =>
    compareNodes(nodes.get(left)!, nodes.get(right)!)
  // 同一组里的子任务按前置关系排序，前置在上，兄弟之间的依赖就能用竖线表示。
  for (const list of childrenOf.values()) list.splice(0, list.length, ...orderSiblings(list, nodes, preOf))
  roots.sort(compareIds)
  for (const node of nodes.values()) node.childIds = childrenOf.get(node.id) ?? []

  const preEdges: Array<{ from: string; to: string }> = []
  for (const [id, pre] of preOf) if (pre) preEdges.push({ from: pre, to: id })
  assignDepths(nodes, preEdges)

  // 自底向上量出分组节点的大小：标题条 + 子节点堆叠。
  const sizes = new Map<string, { width: number; height: number }>()
  const measure = (id: string): { width: number; height: number } => {
    const cached = sizes.get(id)
    if (cached) return cached
    const kids = nodes.get(id)!.childIds
    let result = { width: NODE_WIDTH, height: HEADER_HEIGHT }
    if (kids.length > 0) {
      let widest = 0
      let total = 0
      kids.forEach((kid, index) => {
        const size = measure(kid)
        widest = Math.max(widest, size.width)
        total += size.height + (index === 0 ? 0 : CHILD_GAP)
      })
      result = {
        width: Math.max(NODE_WIDTH, CHILD_INDENT + widest + GROUP_PAD),
        height: HEADER_HEIGHT + CHILD_GAP + total + GROUP_PAD,
      }
    }
    sizes.set(id, result)
    return result
  }
  for (const node of nodes.values()) {
    const size = measure(node.id)
    node.width = size.width
    node.height = size.height
  }

  // 手动拖过的根节点保留坐标，其余根节点仍按前置依赖分列。
  const rootPos = new Map<string, { x: number; y: number }>()
  const pinned = new Set<string>()
  for (const id of roots) {
    const point = positions[id]
    if (!point) continue
    rootPos.set(id, { x: Math.max(PADDING, point.x), y: Math.max(PADDING, point.y) })
    pinned.add(id)
  }

  const columns = new Map<number, string[]>()
  for (const id of roots) {
    if (pinned.has(id)) continue
    const depth = nodes.get(id)!.depth
    const column = columns.get(depth)
    if (column) column.push(id)
    else columns.set(depth, [id])
  }
  const depths = [...columns.keys()].sort((left, right) => left - right)
  const columnHeights = new Map<number, number>()
  for (const depth of depths) {
    const column = columns.get(depth)!
    const height =
      column.reduce((sum, id) => sum + nodes.get(id)!.height, 0) +
      Math.max(0, column.length - 1) * ROOT_GAP
    columnHeights.set(depth, height)
  }
  const tallest =
    depths.length > 0 ? Math.max(...depths.map((depth) => columnHeights.get(depth)!)) : 0

  const xOf = new Map<number, number>()
  let x = PADDING
  for (const depth of depths) {
    xOf.set(depth, x)
    const widest = Math.max(...columns.get(depth)!.map((id) => nodes.get(id)!.width))
    x += widest + COLUMN_GAP
  }
  for (const depth of depths) {
    const column = columns.get(depth)!
    let y = PADDING + Math.max(0, (tallest - columnHeights.get(depth)!) / 2)
    for (const id of column) {
      rootPos.set(id, { x: xOf.get(depth)!, y })
      y += nodes.get(id)!.height + ROOT_GAP
    }
  }

  // 自动摆放的根节点让开手动位置，避免分组变大后压住别人。
  const boxes = roots.map((id) => ({
    id,
    ...rootPos.get(id)!,
    width: nodes.get(id)!.width,
    height: nodes.get(id)!.height,
  }))
  for (let pass = 0; pass < 6; pass += 1) {
    let moved = false
    for (const box of boxes) {
      if (pinned.has(box.id)) continue
      for (const other of boxes) {
        if (other.id === box.id) continue
        const overlapsX = box.x < other.x + other.width && other.x < box.x + box.width
        const overlapsY = box.y < other.y + other.height && other.y < box.y + box.height
        if (!overlapsX || !overlapsY) continue
        box.y = other.y + other.height + ROOT_GAP
        moved = true
      }
    }
    if (!moved) break
  }

  const place = (id: string, x: number, y: number) => {
    const node = nodes.get(id)!
    node.x = x
    node.y = y
    let childY = y + HEADER_HEIGHT + CHILD_GAP
    for (const kid of node.childIds) {
      place(kid, x + CHILD_INDENT, childY)
      childY += nodes.get(kid)!.height + CHILD_GAP
    }
  }
  for (const box of boxes) rootPos.set(box.id, { x: box.x, y: box.y })
  for (const id of roots) {
    const point = rootPos.get(id)!
    place(id, point.x, point.y)
  }

  const plans: EdgePlan[] = []
  for (const edge of preEdges) {
    const from = nodes.get(edge.from)
    const to = nodes.get(edge.to)
    if (!from || !to) continue
    // 跨组的依赖连线画在分组外框上，箭头指向目标任务所在的分组；
    // 同组内的依赖仍连到具体任务，前置在上、依赖在下。
    const fromBox = topLevelNode(from, nodes)
    const toBox = topLevelNode(to, nodes)
    if (fromBox.id === toBox.id) {
      plans.push({ from, to, fromAnchor: from, toAnchor: to, kind: 'sibling' })
    } else if (toBox.x >= fromBox.x + fromBox.width) {
      plans.push({ from, to, fromAnchor: fromBox, toAnchor: toBox, kind: 'forward' })
    } else if (overlaps(fromBox, toBox) && toBox.y > fromBox.y) {
      plans.push({ from, to, fromAnchor: fromBox, toAnchor: toBox, kind: 'vertical' })
    } else {
      plans.push({ from, to, fromAnchor: fromBox, toAnchor: toBox, kind: 'back' })
    }
  }

  // 同一个锚点上的多条线错开位置，避免叠成一条粗线看不清。
  const outSlots = anchorSlots(plans, 'from')
  const inSlots = anchorSlots(plans, 'to')
  const edges: TaskGraphEdge[] = []
  let hasBack = false
  for (const plan of plans) {
    const out = outSlots(plan.fromAnchor.id)
    const inc = inSlots(plan.toAnchor.id)
    const outY = spreadY(plan.fromAnchor, out.index, out.count)
    const inY = spreadY(plan.toAnchor, inc.index, inc.count)
    const outX = spreadX(plan.fromAnchor, out.index, out.count)
    const inX = spreadX(plan.toAnchor, inc.index, inc.count)
    if (plan.kind === 'sibling') {
      edges.push({
        from: plan.from.id,
        to: plan.to.id,
        back: false,
        path: siblingPath(plan.from, plan.to, outX, inX),
      })
      continue
    }
    if (plan.kind === 'forward') {
      edges.push({
        from: plan.from.id,
        to: plan.to.id,
        back: false,
        path: forwardPath(plan.fromAnchor, plan.toAnchor, outY, inY),
      })
      continue
    }
    if (plan.kind === 'vertical') {
      edges.push({
        from: plan.from.id,
        to: plan.to.id,
        back: false,
        path: verticalPath(plan.fromAnchor, plan.toAnchor, outX, inX),
      })
      continue
    }
    hasBack = true
    edges.push({
      from: plan.from.id,
      to: plan.to.id,
      back: true,
      path: backPath(plan.fromAnchor, plan.toAnchor, outY, inX),
    })
  }

  let right = PADDING
  let bottom = PADDING
  for (const node of nodes.values()) {
    right = Math.max(right, node.x + node.width)
    bottom = Math.max(bottom, node.y + node.height)
  }

  return {
    nodes: [...nodes.values()],
    roots,
    edges,
    width: right + PADDING,
    height: bottom + PADDING + (hasBack ? BACK_EDGE_ROOM : 0),
    hidden: tasks.length - shown.length,
  }
}

/**
 * 最长路径分层。先用深度优先找出回边，再只在前进边上做松弛：
 * 前置字段出现环时不会把层级越推越深。
 */
function assignDepths(
  nodes: Map<string, TaskGraphNode>,
  edges: Array<{ from: string; to: string }>,
): void {
  const next = new Map<string, string[]>()
  for (const edge of edges) {
    const list = next.get(edge.from)
    if (list) list.push(edge.to)
    else next.set(edge.from, [edge.to])
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const back = new Set<string>()
  const walk = (id: string): void => {
    if (visiting.has(id) || visited.has(id)) return
    visiting.add(id)
    for (const to of next.get(id) ?? []) {
      if (visiting.has(to)) back.add(`${id}->${to}`)
      else walk(to)
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of nodes.keys()) walk(id)

  const forward = edges.filter((edge) => !back.has(`${edge.from}->${edge.to}`))
  for (let round = 0; round < nodes.size; round += 1) {
    let changed = false
    for (const edge of forward) {
      const from = nodes.get(edge.from)
      const to = nodes.get(edge.to)
      if (!from || !to) continue
      if (to.depth < from.depth + 1) {
        to.depth = from.depth + 1
        changed = true
      }
    }
    if (!changed) break
  }
}

/** 拖动中的节点和哪个节点重叠最多，重叠到一半以上就返回那个节点。 */
export function findOverlapParent(
  nodes: TaskGraphNode[],
  source: TaskGraphNode,
  x: number,
  y: number,
): string | null {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const skip = new Set<string>([source.id])
  const collect = (node: TaskGraphNode) => {
    for (const childId of node.childIds) {
      if (skip.has(childId)) continue
      skip.add(childId)
      const child = byId.get(childId)
      if (child) collect(child)
    }
  }
  collect(source)

  let best: { id: string; ratio: number } | null = null
  for (const node of nodes) {
    if (skip.has(node.id)) continue
    const width = Math.min(x + source.width, node.x + node.width) - Math.max(x, node.x)
    const height = Math.min(y + source.height, node.y + node.height) - Math.max(y, node.y)
    if (width <= 0 || height <= 0) continue
    const smaller = Math.min(source.width * source.height, node.width * node.height)
    if (smaller <= 0) continue
    const ratio = (width * height) / smaller
    if (ratio < 0.5) continue
    if (!best || ratio > best.ratio) best = { id: node.id, ratio }
  }
  return best?.id ?? null
}

/**
 * 新边会不会在关系链上形成环。
 * parent 新边把 `from` 设为 `to` 的父任务，沿 `from` 的父链往上找 `to`；
 * pre 新边把 `from` 设为 `to` 的前置，沿 `from` 的前置链往前找 `to`。
 */
export function relationCreatesCycle(
  tasks: Task[],
  kind: TaskGraphEdgeKind,
  from: string,
  to: string,
): boolean {
  if (from === to) return true
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visited = new Set<string>()
  let current = kind === 'parent' ? byId.get(from)?.parent_id : byId.get(from)?.pre_id
  while (current && !visited.has(current)) {
    if (current === to) return true
    visited.add(current)
    current = kind === 'parent' ? byId.get(current)?.parent_id : byId.get(current)?.pre_id
  }
  return false
}

/** 兄弟节点的基础顺序：按更新时间从旧到新，没有更新时间时按创建时间。 */
function compareByUpdate(left: TaskGraphNode, right: TaskGraphNode): number {
  const leftAt = left.updatedAt ?? left.createdAt
  const rightAt = right.updatedAt ?? right.createdAt
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1
  return left.id.localeCompare(right.id)
}

/** 兄弟节点排序：先按更新时间，再让前置任务排在依赖它的任务之前。 */
function orderSiblings(
  ids: string[],
  nodes: Map<string, TaskGraphNode>,
  preOf: Map<string, string | null>,
): string[] {
  const base = [...ids].sort((left, right) =>
    compareByUpdate(nodes.get(left)!, nodes.get(right)!),
  )
  const members = new Set(ids)
  const placed = new Set<string>()
  const ordered: string[] = []
  const predecessorOf = (id: string) => {
    const pre = preOf.get(id)
    return pre && members.has(pre) ? pre : null
  }
  while (ordered.length < base.length) {
    const next = base.find((id) => {
      if (placed.has(id)) return false
      const pre = predecessorOf(id)
      return pre === null || placed.has(pre)
    })
    // 前置成环时剩余节点按原顺序收尾，避免死循环。
    const pick = next ?? base.find((id) => !placed.has(id))!
    placed.add(pick)
    ordered.push(pick)
  }
  return ordered
}

/** 同组兄弟之间的前置依赖：相邻时竖直连线，隔着其它兄弟时绕到右侧。 */
function siblingPath(
  from: TaskGraphNode,
  to: TaskGraphNode,
  fromX: number,
  toX: number,
): string {
  const fromY = from.y + from.height
  const toY = to.y - ARROW_GAP
  if (toY >= fromY) {
    const gap = toY - fromY
    if (gap <= CHILD_GAP + 2) {
      return `M ${fromX} ${fromY} C ${fromX} ${fromY + gap / 2}, ${toX} ${toY - gap / 2}, ${toX} ${toY}`
    }
    // 中间隔着别的兄弟：从子节点右侧的留白绕过去，不穿过中间的节点。
    const right = Math.max(from.x + from.width, to.x + to.width) + 6
    const mid = (fromY + toY) / 2
    return `M ${fromX} ${fromY} C ${fromX} ${fromY + 6}, ${right} ${fromY + 6}, ${right} ${mid} C ${right} ${toY - 6}, ${toX} ${toY - 6}, ${toX} ${toY}`
  }
  // 反过来时绕到右侧，别穿过同组的其它节点。
  const right = Math.max(from.x + from.width, to.x + to.width) + 18
  return `M ${fromX} ${fromY} C ${right} ${fromY}, ${right} ${toY}, ${toX} ${toY}`
}

function compareNodes(left: TaskGraphNode, right: TaskGraphNode): number {
  const status = STATUS_RANK[left.status] - STATUS_RANK[right.status]
  if (status !== 0) return status
  const priority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]
  if (priority !== 0) return priority
  return left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
}

/** 跨组连线的起点与终点用最外层的分组外框，避免线条钻进分组内部。 */
function topLevelNode(
  node: TaskGraphNode,
  nodes: Map<string, TaskGraphNode>,
): TaskGraphNode {
  let current = node
  const seen = new Set<string>([node.id])
  while (current.parentId) {
    const parent = nodes.get(current.parentId)
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    current = parent
  }
  return current
}

/** 两个分组在横向上是否重叠；判断上下连线还是绕行。 */
function overlaps(left: TaskGraphNode, right: TaskGraphNode): boolean {
  return left.x < right.x + right.width && right.x < left.x + left.width
}

interface EdgePlan {
  from: TaskGraphNode
  to: TaskGraphNode
  fromAnchor: TaskGraphNode
  toAnchor: TaskGraphNode
  kind: 'sibling' | 'forward' | 'vertical' | 'back'
}

/** 统计每个锚点上的入线、出线，以及当前这条线是第几条。 */
function anchorSlots(plans: EdgePlan[], side: 'from' | 'to') {
  const totals = new Map<string, number>()
  for (const plan of plans) {
    const id = (side === 'from' ? plan.fromAnchor : plan.toAnchor).id
    totals.set(id, (totals.get(id) ?? 0) + 1)
  }
  const used = new Map<string, number>()
  return (id: string) => {
    const index = used.get(id) ?? 0
    used.set(id, index + 1)
    return { index, count: totals.get(id) ?? 1 }
  }
}

/** 同一个锚点上的多条线在标题条高度内均匀错开。 */
function spreadY(node: TaskGraphNode, index: number, count: number): number {
  const center = node.y + HEADER_HEIGHT / 2
  if (count <= 1) return center
  const step = Math.min(12, (HEADER_HEIGHT - 16) / (count - 1))
  return center + (index - (count - 1) / 2) * step
}

/** 竖直连线的锚点在节点宽度内错开。 */
function spreadX(node: TaskGraphNode, index: number, count: number): number {
  const center = node.x + node.width / 2
  if (count <= 1) return center
  const step = Math.min(24, (node.width - 40) / (count - 1))
  return center + (index - (count - 1) / 2) * step
}

function forwardPath(
  from: TaskGraphNode,
  to: TaskGraphNode,
  y1: number,
  y2: number,
): string {
  const x1 = from.x + from.width
  const x2 = to.x - ARROW_GAP
  const mid = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
}

/** 同一列上下相邻的两个分组，用竖线连接，箭头指向下面那个。 */
function verticalPath(
  from: TaskGraphNode,
  to: TaskGraphNode,
  x1: number,
  x2: number,
): string {
  const fromY = from.y + from.height
  const toY = to.y - ARROW_GAP
  return `M ${x1} ${fromY} C ${x1} ${fromY + 12}, ${x2} ${toY - 12}, ${x2} ${toY}`
}

/** 目标在当前列的上面或左边，绕到底部再回来。 */
function backPath(
  from: TaskGraphNode,
  to: TaskGraphNode,
  y1: number,
  x2: number,
): string {
  const x1 = from.x + from.width
  const bottom = Math.max(from.y + from.height, to.y + to.height)
  const exitX = x1 + 28
  return `M ${x1} ${y1} C ${exitX} ${y1}, ${exitX} ${bottom + 24}, ${x2} ${bottom + 24} L ${x2} ${to.y + to.height + ARROW_GAP}`
}
