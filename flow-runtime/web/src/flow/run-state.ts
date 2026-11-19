// 运行事实 → 图上状态：节点访问、当前节点与实际走过的结果边。
// 只做读取，不重新判断路由；并行开始点没有节点记录，轮次记录负责它的状态。
import type { NodeRun, RunHistory, RunRecord } from '../data'
import { edgeId, FINISH, START, type FlowGraph } from './graph'

export type RunNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted'

export interface NodeRunState {
  status: RunNodeStatus
  /** 访问次数；并行开始点按轮次计。 */
  visits: number
  lastNodeRunId?: string
  lastResult?: string
}

export interface EdgeRunState {
  traversed: number
  lastResult?: string
}

export interface RunFlowState {
  nodes: Record<string, NodeRunState>
  edges: Record<string, EdgeRunState>
  currentRef?: string
  runStatus?: string
}

const runStatuses: Record<string, RunNodeStatus> = {
  running: 'running',
  joining: 'running',
  completed: 'completed',
  failed: 'failed',
  interrupted: 'interrupted',
}

const statusOf = (status: string): RunNodeStatus => runStatuses[status] ?? 'pending'

export function runFlowState(
  graph: FlowGraph,
  run: RunRecord | undefined,
  history: RunHistory,
): RunFlowState {
  const known = new Set(graph.nodes.map((node) => node.ref))
  const edgeIds = new Set(graph.edges.map((edge) => edge.id))
  const nodes: Record<string, NodeRunState> = {}
  const edges: Record<string, EdgeRunState> = {}
  const ensure = (ref: string): NodeRunState =>
    (nodes[ref] ??= { status: 'pending', visits: 0 })

  const visits = new Map<string, NodeRun>()
  for (const node of history.nodeRuns ?? []) {
    if (!known.has(node.nodeRef)) continue
    visits.set(node.id, node)
    const state = ensure(node.nodeRef)
    state.visits += 1
    state.status = statusOf(node.status)
    state.lastNodeRunId = node.id
    const result = node.outcome?.result ?? node.error?.summary
    if (result) state.lastResult = result
  }

  const walk = (from: string, result: string | undefined, to: string) => {
    const id = edgeId(from, result, to)
    if (!edgeIds.has(id)) return
    edges[id] = {
      traversed: (edges[id]?.traversed ?? 0) + 1,
      ...(result ? { lastResult: result } : {}),
    }
  }

  for (const round of history.parallelRounds ?? []) {
    if (!known.has(round.parallelRef)) continue
    const state = ensure(round.parallelRef)
    state.visits += 1
    state.status = statusOf(round.status)
    state.lastResult = round.status
    // 并行开始点的出边没有结果名，也没有路由记录，由分支记录确认已启动。
    for (const branch of Object.keys(round.branchNodeRunIds ?? {}))
      walk(round.parallelRef, undefined, branch)
  }

  for (const decision of history.routeDecisions ?? []) {
    const source = visits.get(decision.sourceNodeRunId)
    if (!source) continue
    const to = decision.destination.kind === 'finish' ? FINISH : decision.destination.ref
    walk(source.nodeRef, decision.result, to)
  }

  // 开始节点的出边不经路由决策，首个被访问的节点就是实际走过的边。
  if (known.has(START))
    for (const node of history.nodeRuns ?? [])
      if (node.enteredFrom?.kind === 'start') walk(START, undefined, node.nodeRef)

  const running = (history.nodeRuns ?? []).find((node) => node.status === 'running')
  const currentRef =
    run?.currentNodeRef && known.has(run.currentNodeRef as string)
      ? (run.currentNodeRef as string)
      : running && known.has(running.nodeRef)
        ? running.nodeRef
        : undefined

  return { nodes, edges, ...(currentRef ? { currentRef } : {}), runStatus: run?.status }
}
