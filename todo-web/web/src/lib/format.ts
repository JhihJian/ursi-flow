import type { Priority, Task, TaskStatus } from '@/api/types'

const prioritySymbols: Record<Priority, string> = {
  high: '!',
  medium: '-',
  low: '○',
}

const statusSymbols: Record<TaskStatus, string> = {
  done: '✓',
  in_progress: '●',
  blocked: '◆',
  pending: '○',
  cancelled: '×',
}

// 状态色与 styles.css 中的 --status-* 变量一一对应，class 由组件拼接使用。
export const STATUS_CLASS: Record<TaskStatus, string> = {
  done: 'task-status-done',
  in_progress: 'task-status-in_progress',
  blocked: 'task-status-blocked',
  pending: 'task-status-pending',
  cancelled: 'task-status-cancelled',
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'pending',
  in_progress: 'in_progress',
  blocked: 'blocked',
  done: 'done',
  cancelled: 'cancelled',
}

export function prioritySymbol(priority: Priority): string {
  return prioritySymbols[priority]
}

export function statusSymbol(status: TaskStatus): string {
  return statusSymbols[status]
}

export function formatTime(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return '0m'
  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)
  if (hours === 0) return `${rest}m`
  if (rest === 0) return `${hours}h`
  return `${hours}h ${rest}m`
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleDateString('zh-CN')
}

export function formatShortDate(value: string | null | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

export function elapsedMinutes(
  startedAt: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!startedAt) return null
  const started = new Date(startedAt).getTime()
  if (Number.isNaN(started)) return null
  return Math.max(0, Math.round((now - started) / 60_000))
}

export function formatTaskTime(task: Task, now = Date.now()): string {
  const start = task.started_at ?? task.created_at
  const date = formatShortDate(start)
  let duration = '-'
  if (task.status === 'done' && task.started_at && task.finished_at) {
    const elapsed =
      (new Date(task.finished_at).getTime() - new Date(task.started_at).getTime()) / 60_000
    duration = formatTime(Math.max(0, Math.round(elapsed)))
  } else if (task.status === 'in_progress' && task.started_at) {
    duration = formatTime(elapsedMinutes(task.started_at, now) ?? 0)
  }
  return `${date} · ${duration}`
}

export function taskTimeInfo(task: Task): string {
  const parts = [`Created: ${formatDate(task.started_at ?? task.created_at)}`]
  if (task.started_at) parts.push(`Started: ${formatDate(task.started_at)}`)
  if (task.finished_at) parts.push(`Finished: ${formatDate(task.finished_at)}`)
  return parts.join(' | ')
}
