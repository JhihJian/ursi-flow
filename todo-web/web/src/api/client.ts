import type {
  Period,
  ProjectInput,
  ProjectStats,
  Stats,
  StatsPeriod,
  Task,
  TaskDraft,
  TaskStatus,
} from './types'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(body?.error ?? `API error: ${response.status}`, response.status)
  }
  return (await response.json()) as T
}

export function listProjects(activeOnly = false): Promise<{ projects: ProjectStats[] }> {
  return request(`/projects?active_only=${activeOnly ? 'true' : 'false'}`)
}

export function createProject(input: ProjectInput): Promise<{ id: string }> {
  return request('/projects', { method: 'POST', body: JSON.stringify(input) })
}

export function updateProject(id: string, input: ProjectInput): Promise<{ success: boolean }> {
  return request(`/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function deleteProject(id: string): Promise<{ success: boolean }> {
  return request(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export interface TaskQuery {
  project?: string | null
  status?: TaskStatus
  period?: Period
}

export function listTasks(query: TaskQuery = {}): Promise<{ tasks: Task[] }> {
  const params = new URLSearchParams()
  if (query.project) params.set('project', query.project)
  if (query.status) params.set('status', query.status)
  if (query.period && query.period !== 'all') params.set('period', query.period)
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  return request(`/tasks${suffix}`)
}

export function createTask(input: {
  title: string
  priority: TaskDraft['priority']
  tags: string[]
  project_id: string | null
}): Promise<{ id: string }> {
  return request('/tasks', { method: 'POST', body: JSON.stringify(input) })
}

export function updateTask(
  id: string,
  input: Partial<{
    title: string
    priority: TaskDraft['priority']
    status: TaskStatus
    tags: string[]
    project_id: string | null
    result: string | null
  }>,
): Promise<{ success: boolean }> {
  return request(`/tasks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function deleteTask(id: string): Promise<{ success: boolean }> {
  return request(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function getStats(period: StatsPeriod): Promise<{ stats: Stats }> {
  return request(`/stats?period=${period}`)
}
