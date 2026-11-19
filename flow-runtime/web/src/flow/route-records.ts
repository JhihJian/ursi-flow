// 路由记录：把节点执行与路由判定摊平成一条按时间排列的事件序列。
// 节点开始带当时的入参，节点结束带提交的结果，路由判定带结果与去向。
import type { NodeRun, RouteDecision } from '../data'

export type RouteRecordKind = 'start' | 'finish' | 'decision'

export interface RouteRecord {
  id: string
  kind: RouteRecordKind
  at: string
  nodeRun?: NodeRun
  decision?: RouteDecision
}

// 时间戳相同的记录按因果关系排：先结束、再判定、最后才开始下一个节点。
// 同一个节点自己的开始一定在结束之前，即使两者落在同一秒。
const rank: Record<RouteRecordKind, number> = { finish: 0, decision: 1, start: 2 }
const sequenceOf = (record: RouteRecord) =>
  record.nodeRun?.sequence ?? record.decision?.sequence ?? 0

function orderInSameInstant(left: RouteRecord, right: RouteRecord) {
  const sameNode = left.nodeRun && right.nodeRun && left.nodeRun.id === right.nodeRun.id
  if (sameNode) return rank[right.kind] - rank[left.kind]
  return rank[left.kind] - rank[right.kind]
}

export function routeRecords(facts: {
  nodeRuns: NodeRun[]
  routeDecisions: RouteDecision[]
}): RouteRecord[] {
  const records: RouteRecord[] = []
  for (const node of facts.nodeRuns) {
    records.push({ id: `start:${node.id}`, kind: 'start', at: node.startedAt, nodeRun: node })
    // 还在执行的节点只有开始记录，结束记录等它提交事实后再出现。
    if (node.completedAt)
      records.push({
        id: `finish:${node.id}`,
        kind: 'finish',
        at: node.completedAt,
        nodeRun: node,
      })
  }
  for (const decision of facts.routeDecisions)
    records.push({
      id: `decision:${decision.id}`,
      kind: 'decision',
      at: decision.selectedAt,
      decision,
    })
  return records.sort(
    (left, right) =>
      left.at.localeCompare(right.at) ||
      orderInSameInstant(left, right) ||
      sequenceOf(left) - sequenceOf(right),
  )
}

/** 表里只放时刻：一次运行的记录都在同一天，日期放到记录详情里。 */
export const clock = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString('zh-CN', { hour12: false })
}

/** 节点结束记录的一句话结论，表与详情共用。 */
export function finishSummary(node: NodeRun): string {
  const result = node.outcome?.result
  if (result) return `提交 ${result}`
  if (node.error) return node.error.summary
  return '未提交结果'
}

/** 路由判定的一句话结论：结果决定了哪个出口。 */
export function decisionSummary(
  decision: RouteDecision,
  nameOf: (ref: string) => string = (ref) => ref,
): string {
  const target =
    decision.destination.kind === 'finish' ? '结束' : nameOf(decision.destination.ref)
  return `${decision.result} → ${target}`
}

/** 节点是从哪进来的：首节点、上一步判定、并行分支还是恢复。 */
export function enteredFromLabel(source: NodeRun['enteredFrom']): string {
  if (source.kind === 'start') return '首个节点'
  if (source.kind === 'route') return '上一步判定'
  if (source.kind === 'parallel') return '并行分支'
  if (source.kind === 'recovery') return '恢复重试'
  return source.kind
}
