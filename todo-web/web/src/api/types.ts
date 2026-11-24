export type Priority = 'high' | 'medium' | 'low'
export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
export type Period = 'daily' | 'weekly' | 'monthly' | 'all'
export type StatsPeriod = Exclude<Period, 'all'>

export interface Task {
  id: string
  title: string
  priority: Priority
  status: TaskStatus
  tags: string[]
  project_id: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  blocked_reason: string | null
  result: string | null
}

export interface TaskCount {
  pending: number
  in_progress: number
  blocked: number
  done: number
}

export interface ProjectStats {
  id: string
  name: string
  description: string | null
  path: string | null
  task_count: TaskCount
  total_time_minutes: number
}

export interface Stats {
  period: string
  start: string
  end: string
  total_tasks: number
  total_time_minutes: number
  by_status: TaskCount
}

export interface ProjectInput {
  name: string
  description: string | null
  path: string | null
}

export interface TaskInput {
  title: string
  priority: Priority
  status: TaskStatus
  tags: string[]
  result: string | null
}

export interface TaskDraft extends TaskInput {
  id: string | null
}
