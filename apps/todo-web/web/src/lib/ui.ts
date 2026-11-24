import type { Task, TaskStatus } from '@/api/types'

export interface TaskDragData {
  type: 'task'
  task: Task
}

export interface StatusDropData {
  type: 'status'
  status: TaskStatus
}

export interface ProjectDropData {
  type: 'project'
  projectId: string
}

export type DropData = StatusDropData | ProjectDropData

export function readTaskDrag(data: unknown): TaskDragData | null {
  if (!data || typeof data !== 'object') return null
  const candidate = data as Partial<TaskDragData>
  return candidate.type === 'task' && candidate.task ? (candidate as TaskDragData) : null
}

export function readDropData(data: unknown): DropData | null {
  if (!data || typeof data !== 'object') return null
  const candidate = data as Partial<DropData>
  if (candidate.type === 'status' && candidate.status) return candidate as StatusDropData
  if (candidate.type === 'project' && candidate.projectId) return candidate as ProjectDropData
  return null
}

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
