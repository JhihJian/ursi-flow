import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectStats, Stats, Task } from '@/api/types'

vi.mock('@/api/client', () => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  listTasks: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  getStats: vi.fn(),
}))

import * as api from '@/api/client'
import { useTodoStore } from './todo-store'

const mocked = vi.mocked(api)

const projectA: ProjectStats = {
  id: 'p1',
  name: 'Alpha',
  description: null,
  path: null,
  task_count: { pending: 1, in_progress: 0, blocked: 0, done: 0 },
  total_time_minutes: 0,
}

const projectB: ProjectStats = {
  id: 'p2',
  name: 'Beta',
  description: null,
  path: null,
  task_count: { pending: 1, in_progress: 0, blocked: 0, done: 0 },
  total_time_minutes: 0,
}

const task: Task = {
  id: 't1',
  title: 'Task',
  priority: 'high',
  status: 'pending',
  tags: ['x'],
  project_id: 'p1',
  created_at: '2026-03-01T09:00:00Z',
  started_at: null,
  finished_at: null,
  blocked_reason: null,
  result: null,
}

function stats(period: string): Stats {
  return {
    period,
    start: '2026-03-01',
    end: '2026-03-01',
    total_tasks: 0,
    total_time_minutes: 0,
    by_status: { pending: 0, in_progress: 0, blocked: 0, done: 0 },
  }
}

function resetStore() {
  useTodoStore.setState({
    projects: [],
    tasks: [],
    activeTasks: [],
    stats: { daily: null, weekly: null, monthly: null },
    selectedProjectId: null,
    period: 'daily',
    projectsLoading: true,
    projectsError: false,
    tasksLoading: false,
    activeLoading: true,
    detail: null,
    projectEditing: null,
    projectDeleteConfirm: false,
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocked.listProjects.mockResolvedValue({ projects: [projectA, projectB] })
  mocked.listTasks.mockResolvedValue({ tasks: [task] })
  mocked.getStats.mockImplementation(async (period) => ({ stats: stats(period) }))
  resetStore()
})

describe('bootstrap', () => {
  it('selects the first project and loads stats and active tasks', async () => {
    await useTodoStore.getState().bootstrap()

    const state = useTodoStore.getState()
    expect(state.projects).toHaveLength(2)
    expect(state.selectedProjectId).toBe('p1')
    expect(state.tasks).toEqual([task])
    expect(state.stats.daily?.period).toBe('daily')
    expect(state.projectsLoading).toBe(false)
    expect(mocked.listTasks).toHaveBeenCalledWith({ project: 'p1', period: 'daily' })
    expect(mocked.listTasks).toHaveBeenCalledWith({ status: 'in_progress' })
    expect(mocked.listTasks).toHaveBeenCalledWith({ status: 'blocked' })
  })

  it('reports a project loading error', async () => {
    mocked.listProjects.mockRejectedValue(new Error('offline'))
    await expect(useTodoStore.getState().bootstrap()).rejects.toThrow('offline')
    expect(useTodoStore.getState().projectsError).toBe(true)
    expect(useTodoStore.getState().projectsLoading).toBe(false)
  })
})

describe('task actions', () => {
  it('reloads tasks when the period changes and drops the all-time suffix', async () => {
    useTodoStore.setState({ selectedProjectId: 'p1' })
    await useTodoStore.getState().selectPeriod('weekly')
    expect(mocked.listTasks).toHaveBeenLastCalledWith({ project: 'p1', period: 'weekly' })
    expect(useTodoStore.getState().period).toBe('weekly')
  })

  it('sends status updates only when the status really changes', async () => {
    mocked.updateTask.mockResolvedValue({ success: true })
    await useTodoStore.getState().moveTask(task, { status: 'in_progress' })
    expect(mocked.updateTask).toHaveBeenCalledWith('t1', { status: 'in_progress' })

    vi.clearAllMocks()
    await useTodoStore.getState().moveTask(task, { status: 'pending' })
    expect(mocked.updateTask).not.toHaveBeenCalled()
  })

  it('moves a task to another project', async () => {
    mocked.updateTask.mockResolvedValue({ success: true })
    await useTodoStore.getState().moveTask(task, { projectId: 'p2' })
    expect(mocked.updateTask).toHaveBeenCalledWith('t1', { project_id: 'p2' })
  })

  it('creates new tasks in the selected project', async () => {
    useTodoStore.setState({ selectedProjectId: 'p1' })
    mocked.createTask.mockResolvedValue({ id: 'new' })

    await useTodoStore.getState().saveTask({
      id: null,
      title: 'New task',
      priority: 'medium',
      status: 'pending',
      tags: ['a'],
      result: null,
    })

    expect(mocked.createTask).toHaveBeenCalledWith({
      title: 'New task',
      priority: 'medium',
      tags: ['a'],
      project_id: 'p1',
    })
    expect(useTodoStore.getState().detail).toBeNull()
  })

  it('closes the detail panel when the selected task is deleted', async () => {
    useTodoStore.setState({ detail: { mode: 'view', task, confirmDelete: false } })
    mocked.deleteTask.mockResolvedValue({ success: true })

    await useTodoStore.getState().removeTask('t1')

    expect(useTodoStore.getState().detail).toBeNull()
  })
})

describe('project actions', () => {
  it('selects a newly created project', async () => {
    mocked.createProject.mockResolvedValue({ id: 'p3' })
    mocked.listProjects.mockResolvedValue({
      projects: [projectA, projectB, { ...projectA, id: 'p3', name: 'Gamma' }],
    })

    await useTodoStore.getState().saveProject(null, {
      name: 'Gamma',
      description: null,
      path: null,
    })

    expect(useTodoStore.getState().selectedProjectId).toBe('p3')
    expect(useTodoStore.getState().projectEditing).toBeNull()
  })

  it('selects the next project after deleting the current one', async () => {
    useTodoStore.setState({ selectedProjectId: 'p1', projects: [projectA, projectB] })
    mocked.deleteProject.mockResolvedValue({ success: true })
    mocked.listProjects.mockResolvedValue({ projects: [projectB] })

    await useTodoStore.getState().removeProject()

    expect(useTodoStore.getState().selectedProjectId).toBe('p2')
    expect(useTodoStore.getState().projects.map((project) => project.id)).toEqual(['p2'])
  })
})
