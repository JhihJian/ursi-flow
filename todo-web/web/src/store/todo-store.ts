import { create } from 'zustand'
import * as api from '@/api/client'
import type {
  DayCount,
  ProjectInput,
  ProjectStats,
  Task,
  TaskDraft,
  TaskStatus,
} from '@/api/types'

export type DetailState =
  | { mode: 'view'; task: Task }
  | { mode: 'new' }

export interface ProjectEditing {
  /** null 表示新建项目。 */
  id: string | null
}

export type MoveTarget = { status: TaskStatus } | { projectId: string }

export interface TodoState {
  projects: ProjectStats[]
  tasks: Task[]
  selectedProjectId: string | null
  statusFilter: TaskStatus | null
  dayCounts: DayCount[]
  dayFilter: string | null
  projectsLoading: boolean
  projectsError: boolean
  tasksLoading: boolean
  detail: DetailState | null
  projectEditing: ProjectEditing | null

  bootstrap: () => Promise<void>
  selectProject: (id: string) => Promise<void>
  toggleStatusFilter: (status: TaskStatus) => void
  toggleDayFilter: (date: string) => Promise<void>
  refreshDayCounts: () => Promise<void>
  refreshProjects: () => Promise<void>
  refreshTasks: (clear?: boolean) => Promise<void>
  refreshAll: () => Promise<void>
  openTask: (task: Task) => void
  openNewTask: () => void
  closeDetail: () => void
  saveTask: (draft: TaskDraft) => Promise<void>
  removeTask: (id: string) => Promise<void>
  moveTask: (task: Task, target: MoveTarget, blockedReason?: string) => Promise<void>
  startCreateProject: () => void
  startEditProject: (id: string) => void
  cancelProjectForm: () => void
  saveProject: (id: string | null, input: ProjectInput) => Promise<void>
  removeProject: (id: string) => Promise<void>
}

let tasksRequestId = 0

export const useTodoStore = create<TodoState>((set, get) => ({
  projects: [],
  tasks: [],
  selectedProjectId: null,
  statusFilter: null,
  dayCounts: [],
  dayFilter: null,
  projectsLoading: true,
  projectsError: false,
  tasksLoading: false,
  detail: null,
  projectEditing: null,

  bootstrap: async () => {
    await get().refreshProjects()
    const first = get().projects[0]
    if (first) {
      await get().selectProject(first.id)
    } else {
      set({ selectedProjectId: null, tasks: [], dayCounts: [] })
    }
  },

  selectProject: async (id) => {
    set({
      selectedProjectId: id,
      detail: null,
      projectEditing: null,
    })
    await Promise.all([get().refreshTasks(true), get().refreshDayCounts()])
  },

  toggleStatusFilter: (status) => {
    set({ statusFilter: get().statusFilter === status ? null : status })
  },

  toggleDayFilter: async (date) => {
    set({ dayFilter: get().dayFilter === date ? null : date })
    await get().refreshTasks()
  },

  refreshDayCounts: async () => {
    const { selectedProjectId } = get()
    if (!selectedProjectId) {
      set({ dayCounts: [] })
      return
    }
    const { days } = await api.listDailyCounts(selectedProjectId, 7)
    set({ dayCounts: days })
  },

  refreshProjects: async () => {
    const hasProjects = get().projects.length > 0
    set({ projectsLoading: !hasProjects, projectsError: false })
    try {
      const { projects } = await api.listProjects(false)
      set({ projects, projectsLoading: false })
    } catch (error) {
      set({ projectsLoading: false, projectsError: !hasProjects })
      throw error
    }
  },

  refreshTasks: async (clear = false) => {
    const { selectedProjectId, dayFilter } = get()
    const requestId = ++tasksRequestId
    if (!selectedProjectId) {
      set({ tasks: [], tasksLoading: false })
      return
    }
    if (clear) set({ tasks: [], tasksLoading: true })
    try {
      const { tasks } = await api.listTasks({
        project: selectedProjectId,
        date: dayFilter,
      })
      if (requestId !== tasksRequestId) return
      set({ tasks, tasksLoading: false })
    } catch (error) {
      if (requestId === tasksRequestId) set({ tasksLoading: false })
      throw error
    }
  },

  refreshAll: async () => {
    await Promise.all([
      get().refreshProjects(),
      get().refreshTasks(),
      get().refreshDayCounts(),
    ])
  },

  openTask: (task) => set({ detail: { mode: 'view', task } }),

  openNewTask: () =>
    set({
      detail: { mode: 'new' },
      projectEditing: null,
    }),

  closeDetail: () => set({ detail: null }),

  saveTask: async (draft) => {
    if (draft.id) {
      await api.updateTask(draft.id, {
        title: draft.title,
        priority: draft.priority,
        status: draft.status,
        tags: draft.tags,
        result: draft.result,
        workspace: draft.workspace,
        session_id: draft.sessionId,
      })
    } else {
      await api.createTask({
        title: draft.title,
        priority: draft.priority,
        tags: draft.tags,
        project_id: get().selectedProjectId,
        workspace: draft.workspace,
        session_id: draft.sessionId,
      })
    }
    set({ detail: null })
    await get().refreshAll()
  },

  removeTask: async (id) => {
    await api.deleteTask(id)
    const detail = get().detail
    if (detail?.mode === 'view' && detail.task.id === id) set({ detail: null })
    await get().refreshAll()
  },

  moveTask: async (task, target, blockedReason) => {
    if ('status' in target) {
      if (task.status === target.status) return
      // 阻塞必须带原因，规则来自 todo-core 状态机。
      await api.updateTask(task.id, {
        status: target.status,
        ...(target.status === 'blocked' ? { blocked_reason: blockedReason ?? '' } : {}),
      })
    } else {
      if (task.project_id === target.projectId) return
      await api.updateTask(task.id, { project_id: target.projectId })
    }
    const detail = get().detail
    if (detail?.mode === 'view' && detail.task.id === task.id) set({ detail: null })
    await get().refreshAll()
  },

  startCreateProject: () => set({ projectEditing: { id: null }, detail: null }),

  startEditProject: (id) => set({ projectEditing: { id }, detail: null }),

  cancelProjectForm: () => set({ projectEditing: null }),

  saveProject: async (id, input) => {
    if (id) {
      await api.updateProject(id, input)
      set({ projectEditing: null })
      await get().refreshProjects()
      return
    }
    const created = await api.createProject(input)
    set({ projectEditing: null, selectedProjectId: created.id })
    await get().refreshProjects()
    await get().selectProject(created.id)
  },

  removeProject: async (id) => {
    await api.deleteProject(id)
    const removingSelected = get().selectedProjectId === id
    set({
      detail: null,
      projectEditing: null,
      ...(removingSelected ? { selectedProjectId: null, tasks: [] } : {}),
    })
    await get().refreshProjects()
    if (removingSelected) {
      const first = get().projects[0]
      if (first) await get().selectProject(first.id)
    }
  },
}))
