import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectStats, Task } from '@/api/types'

vi.mock('@/api/client', () => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  listTasks: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  listDailyCounts: vi.fn(),
}))

import * as api from '@/api/client'
import { useTodoStore } from './todo-store'

const mocked = vi.mocked(api)

const projectA: ProjectStats = {
  id: 'p1',
  name: 'Alpha',
  created_at: '2026-03-01T09:00:00Z',
  description: null,
  path: null,
  task_count: { pending: 1, in_progress: 0, blocked: 0, done: 0, cancelled: 0 },
  total_time_minutes: 0,
}

const projectB: ProjectStats = {
  id: 'p2',
  name: 'Beta',
  created_at: '2026-03-01T09:00:00Z',
  description: null,
  path: null,
  task_count: { pending: 1, in_progress: 0, blocked: 0, done: 0, cancelled: 0 },
  total_time_minutes: 0,
}

const task: Task = {
  id: 't1',
  title: 'Task',
  creator: 'human',
  priority: 'high',
  artifacts: [],
  status: 'pending',
  tags: ['x'],
  project_id: 'p1',
  created_at: '2026-03-01T09:00:00Z',
  started_at: null,
  finished_at: null,
  blocked_reason: null,
  result: null,
}

function resetStore() {
  useTodoStore.setState({
    projects: [],
    tasks: [],
    selectedProjectId: null,
    projectsLoading: true,
    projectsError: false,
    tasksLoading: false,
    detail: null,
    projectEditing: null,
    statusFilter: null,
    dayCounts: [],
    dayFilter: null,
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocked.listDailyCounts.mockResolvedValue({ days: [] })
  mocked.listProjects.mockResolvedValue({ projects: [projectA, projectB] })
  mocked.listTasks.mockResolvedValue({ tasks: [task] })
  resetStore()
})

describe('bootstrap', () => {
  it('selects the first project and loads its tasks', async () => {
    await useTodoStore.getState().bootstrap()

    const state = useTodoStore.getState()
    expect(state.projects).toHaveLength(2)
    expect(state.selectedProjectId).toBe('p1')
    expect(state.tasks).toEqual([task])
    expect(state.projectsLoading).toBe(false)
    expect(mocked.listTasks).toHaveBeenCalledWith({ project: 'p1', date: null })
  })

  it('reports a project loading error', async () => {
    mocked.listProjects.mockRejectedValue(new Error('offline'))
    await expect(useTodoStore.getState().bootstrap()).rejects.toThrow('offline')
    expect(useTodoStore.getState().projectsError).toBe(true)
    expect(useTodoStore.getState().projectsLoading).toBe(false)
  })
})

describe('task actions', () => {
  it('sends status updates only when the status really changes', async () => {
    mocked.updateTask.mockResolvedValue({ success: true })
    await useTodoStore.getState().moveTask(task, { status: 'in_progress' })
    expect(mocked.updateTask).toHaveBeenCalledWith('t1', { status: 'in_progress' })

    vi.clearAllMocks()
    await useTodoStore.getState().moveTask(task, { status: 'pending' })
    expect(mocked.updateTask).not.toHaveBeenCalled()
  })

  it('sends a blocked reason when moving to blocked', async () => {
    mocked.updateTask.mockResolvedValue({ success: true })
    await useTodoStore.getState().moveTask(task, { status: 'blocked' }, 'waiting on API')
    expect(mocked.updateTask).toHaveBeenCalledWith('t1', {
      status: 'blocked',
      blocked_reason: 'waiting on API',
    })
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
    useTodoStore.setState({ detail: { mode: 'view', task } })
    mocked.deleteTask.mockResolvedValue({ success: true })

    await useTodoStore.getState().removeTask('t1')

    expect(useTodoStore.getState().detail).toBeNull()
  })
})

describe('status filter', () => {
  it('toggles a day filter and reloads tasks with the date', async () => {
    useTodoStore.setState({ selectedProjectId: 'p1' })
    await useTodoStore.getState().toggleDayFilter('2026-11-24')
    expect(useTodoStore.getState().dayFilter).toBe('2026-11-24')
    expect(mocked.listTasks).toHaveBeenLastCalledWith({
      project: 'p1',
      date: '2026-11-24',
    })

    await useTodoStore.getState().toggleDayFilter('2026-11-24')
    expect(useTodoStore.getState().dayFilter).toBeNull()
    expect(mocked.listTasks).toHaveBeenLastCalledWith({
      project: 'p1',
      date: null,
    })
  })

  it('toggles the filter and clears it when the same status is picked twice', () => {
    expect(useTodoStore.getState().statusFilter).toBeNull()
    useTodoStore.getState().toggleStatusFilter('blocked')
    expect(useTodoStore.getState().statusFilter).toBe('blocked')
    useTodoStore.getState().toggleStatusFilter('done')
    expect(useTodoStore.getState().statusFilter).toBe('done')
    useTodoStore.getState().toggleStatusFilter('done')
    expect(useTodoStore.getState().statusFilter).toBeNull()
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

    await useTodoStore.getState().removeProject('p1')

    expect(useTodoStore.getState().selectedProjectId).toBe('p2')
    expect(useTodoStore.getState().projects.map((project) => project.id)).toEqual(['p2'])
  })
})
