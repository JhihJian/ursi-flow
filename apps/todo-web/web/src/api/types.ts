export type Priority = 'high' | 'medium' | 'low'
export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
export type Creator = 'human' | 'agent'
export type Period = 'daily' | 'weekly' | 'monthly' | 'all'
export type StatsPeriod = Exclude<Period, 'all'>

/**
 * 任务与项目字段与 SUMM-Todo 的 `todo-core` 实体一一对应。
 * 服务端省略空可选字段，因此这些字段既可能缺失也可能是 null。
 */
export interface Task {
  id: string
  title: string
  creator: Creator
  created_at: string
  priority: Priority
  tags: string[]
  status: TaskStatus
  artifacts: string[]
  content?: string | null
  project_id?: string | null
  parent_id?: string | null
  pre_id?: string | null
  due?: string | null
  assignee?: Creator | null
  blocked_reason?: string | null
  result?: string | null
  log?: string | null
  started_at?: string | null
  finished_at?: string | null
  updated_at?: string | null
}

export interface Project {
  id: string
  name: string
  created_at: string
  description?: string | null
  path?: string | null
  updated_at?: string | null
}

export interface TaskCount {
  pending: number
  in_progress: number
  blocked: number
  done: number
  cancelled: number
}

export interface ProjectStats extends Project {
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

export interface DayCount {
  date: string
  count: number
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
  /** 工作过程的记录，Markdown 文本。 */
  log: string | null
  /** 工作结果，Markdown 文本。 */
  result: string | null
}

export interface TaskDraft extends TaskInput {
  id: string | null
}
