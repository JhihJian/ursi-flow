import type { Priority, Task, TaskStatus } from '@/api/types'

/**
 * 把当前项目的任务排成一张从左到右的关系图。
 * 这里只算节点、连线与坐标，不碰 DOM，渲染层把结果画成节点与 SVG 路径。
 *
 * 图的两种关系都来自任务已有的字段：`parent_id` 是层级，`pre_id` 是顺序依赖。
 */

export type TaskGraphEdgeKind = 'parent' | 'pre'

export interface TaskGraphNode {
  id: string
  title: string
  /** 画在节点里的短标题，完整标题留在 `title`。 */
  label: string
  status: TaskStatus
  priority: Priority
  /** 层级：前置任务与父任务算作更浅的一层。 */
  depth: number
  x: number
  y: number
  width: number
  height: number
}

export interface TaskGraphEdge {
  from: string
  to: string
  kind: TaskGraphEdgeKind
  /** 回边：目标层级不深于来源，绕到下方避免压住主链。 */
  back: boolean
  path: string
}

export interface TaskGraphLayout {
  nodes: TaskGraphNode[]
  edges: TaskGraphEdge[]
  width: number
  height: number
  /** 因为已完成或已取消而省略的任务数。 */
  hidden: number
}

const NODE_HEIGHT = 40
const ROW_GAP = 12
const COLUMN_GAP = 64
const PADDING = 16
const MIN_WIDTH = 132
const MAX_WIDTH = 224
const CHAR = 12
const LABEL_LIMIT = 40
/** 回边绕到节点下方，底线之外要留出的空间。 */
const BACK_EDGE_ROOM = 32

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

function labelOf(title: string): string {
  const trimmed = title.trim()
  return trimmed.length > LABEL_LIMIT ? `${trimmed.slice(0, LABEL_LIMIT - 1)}…` : trimmed
}

function widthOf(label: string): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, label.length * CHAR + 52))
}

/**
 * 默认只画未结束的任务。已完成或已取消的任务只在直接挂到未结束任务上时保留：
 * 否则完成一个前置任务后，后续任务的来龙去脉就从图里消失了。
 * 只认直接相邻的一层，避免顺着已结束任务把整条历史链拖进图里。
 */
export function buildTaskGraph(tasks: Task[]): TaskGraphLayout {
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
  const visible = new Set(shown.map((task) => task.id))

  const nodes = new Map<string, TaskGraphNode>()
  for (const task of shown) {
    const label = labelOf(task.title)
    nodes.set(task.id, {
      id: task.id,
      title: task.title,
      label,
      status: task.status,
      priority: task.priority,
      depth: 0,
      x: 0,
      y: 0,
      width: widthOf(label),
      height: NODE_HEIGHT,
    })
  }

  const rawEdges: Array<{ from: string; to: string; kind: TaskGraphEdgeKind }> = []
  for (const task of shown) {
    if (task.parent_id && visible.has(task.parent_id) && task.parent_id !== task.id) {
      rawEdges.push({ from: task.parent_id, to: task.id, kind: 'parent' })
    }
    if (task.pre_id && visible.has(task.pre_id) && task.pre_id !== task.id) {
      rawEdges.push({ from: task.pre_id, to: task.id, kind: 'pre' })
    }
  }

  assignDepths(nodes, rawEdges)
  const placed = place(nodes, rawEdges)
  return { ...placed, hidden: tasks.length - shown.length }
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

function compareNodes(left: TaskGraphNode, right: TaskGraphNode): number {
  const status = STATUS_RANK[left.status] - STATUS_RANK[right.status]
  if (status !== 0) return status
  const priority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]
  if (priority !== 0) return priority
  return left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
}

function place(
  nodes: Map<string, TaskGraphNode>,
  rawEdges: Array<{ from: string; to: string; kind: TaskGraphEdgeKind }>,
): Omit<TaskGraphLayout, 'hidden'> {
  if (nodes.size === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  const rows = new Map<number, TaskGraphNode[]>()
  for (const node of nodes.values()) {
    const row = rows.get(node.depth)
    if (row) row.push(node)
    else rows.set(node.depth, [node])
  }
  const depths = [...rows.keys()].sort((left, right) => left - right)
  for (const depth of depths) rows.get(depth)!.sort(compareNodes)

  const columnWidths = new Map<number, number>()
  for (const depth of depths) {
    columnWidths.set(
      depth,
      Math.max(...rows.get(depth)!.map((node) => node.width)),
    )
  }

  const xOf = new Map<number, number>()
  let x = PADDING
  for (const depth of depths) {
    xOf.set(depth, x)
    x += columnWidths.get(depth)! + COLUMN_GAP
  }

  const tallest = Math.max(...depths.map((depth) => rows.get(depth)!.length))
  const stackHeight = tallest * NODE_HEIGHT + Math.max(0, tallest - 1) * ROW_GAP
  for (const depth of depths) {
    const row = rows.get(depth)!
    const stack = row.length * NODE_HEIGHT + Math.max(0, row.length - 1) * ROW_GAP
    let y = PADDING + Math.max(0, (stackHeight - stack) / 2)
    for (const node of row) {
      node.x = xOf.get(depth)!
      node.y = y
      y += NODE_HEIGHT + ROW_GAP
    }
  }

  const edges: TaskGraphEdge[] = []
  let hasBack = false
  for (const edge of rawEdges) {
    const from = nodes.get(edge.from)
    const to = nodes.get(edge.to)
    if (!from || !to) continue
    const back = to.depth <= from.depth
    if (back) hasBack = true
    const geometry = to.depth === from.depth ? 'same' : back ? 'back' : 'forward'
    edges.push({
      from: from.id,
      to: to.id,
      kind: edge.kind,
      back,
      path: edgePath(from, to, geometry),
    })
  }

  return {
    nodes: [...nodes.values()],
    edges,
    width: x - COLUMN_GAP + PADDING,
    height: PADDING * 2 + stackHeight + (hasBack ? BACK_EDGE_ROOM : 0),
  }
}

function edgePath(
  from: TaskGraphNode,
  to: TaskGraphNode,
  geometry: 'forward' | 'same' | 'back',
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
    return `M ${x1} ${y1} C ${x1 + 32} ${midY}, ${x2 - 32} ${midY}, ${x2} ${y2}`
  }
  const bottom = Math.max(from.y, to.y) + NODE_HEIGHT
  const exitX = x1 + 24
  const entryX = to.x + to.width / 2
  return `M ${x1} ${y1} C ${exitX} ${y1}, ${exitX} ${bottom + 20}, ${entryX} ${bottom + 20} L ${entryX} ${to.y + NODE_HEIGHT}`
}
