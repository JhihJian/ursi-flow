import type { TaskStatus } from '@/api/types'

/** 状态展示顺序：待办、进行中、阻塞、完成、已取消。 */
export const STATUS_ORDER: TaskStatus[] = [
  'pending',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
]

/**
 * 每个状态可迁移到的目标，与 `todo-core` 的 `Task::transition` 一一对应。
 * 界面只在此基础上列出下一步，迁移规则仍然由服务端裁决。
 */
const NEXT_STATUS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['in_progress', 'cancelled'],
  in_progress: ['done', 'blocked', 'cancelled', 'pending'],
  blocked: ['in_progress', 'cancelled'],
  done: ['in_progress'],
  cancelled: [],
}

export function nextStatuses(status: TaskStatus): TaskStatus[] {
  return NEXT_STATUS[status]
}

/** 迁移到目标状态前必须补填的字段，缺失时服务端会拒绝。 */
export function requiredInput(status: TaskStatus): 'result' | 'blocked_reason' | null {
  if (status === 'done') return 'result'
  if (status === 'blocked') return 'blocked_reason'
  return null
}
