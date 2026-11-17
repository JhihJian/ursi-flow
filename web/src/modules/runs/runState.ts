import type { Run, RunEvent, RunStatus } from '@/shared/api/types'
import { errorMessage } from '@/shared/api'

export function runErrorMessage(cause: unknown): string {
  const status = cause && typeof cause === 'object' && 'status' in cause ? cause.status : undefined
  if (status === 403) return '403：当前账号没有执行此操作的权限。'
  if (status === 409) return '409：运行状态已变化或操作存在冲突，请根据最新状态重试。'
  return errorMessage(cause)
}

export const isTerminal = (status: RunStatus) => ['succeeded', 'failed', 'cancelled'].includes(status)
export const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
export const statusLabels: Record<RunStatus, string> = { queued: '排队中', running: '运行中', waiting: '等待审批', succeeded: '已完成', failed: '失败', cancelled: '已取消' }
export interface NumberedEvent extends RunEvent { sequence: number }
/** API 的事件 ID 是身份。前端展示序号在首次收到事件时分配，返工后仍保留。 */
export function mergeEvents(previous: NumberedEvent[], incoming: RunEvent[]): NumberedEvent[] {
  const ids = new Set(previous.map(event => event.id))
  const result = [...previous]
  for (const event of [...incoming].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
    if (ids.has(event.id)) continue
    ids.add(event.id)
    result.push({ ...event, sequence: result.length + 1 })
  }
  return result
}
export function completedAncestors(run: Run) {
  const approval = run.nodes.find(node => node.status === 'waiting_approval')
  if (!approval) return []
  const ancestors = new Set<string>()
  const pending = [approval.id]
  while (pending.length) {
    const id = pending.pop()
    for (const edge of run.snapshot.workflow.edges) {
      if (edge.target === id && !ancestors.has(edge.source)) { ancestors.add(edge.source); pending.push(edge.source) }
    }
  }
  ancestors.delete(approval.id)
  return run.nodes.filter(node => ancestors.has(node.id) && node.status === 'succeeded')
}
