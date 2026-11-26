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
import {
  readPositions,
  writePositions,
  type GraphPoint,
  type GraphPositions,
} from '@/lib/graph-positions'
import { relationCreatesCycle } from '@/lib/task-graph'

export type DetailState =
  | { mode: 'view'; task: Task }
  | { mode: 'new' }

export interface ProjectEditing {
  /** null 表示新建项目。 */
  id: string | null
}

export type MoveTarget = { status: TaskStatus } | { projectId: string }

/** 任务区有两种视图：任务表与任务关系图。 */
export type TaskView = 'list' | 'graph'

const VIEW_KEY = 'todo-web.view'

function readStoredView(): TaskView {
  return localStorage.getItem(VIEW_KEY) === 'graph' ? 'graph' : 'list'
}

export interface TodoState {
  projects: ProjectStats[]
  tasks: Task[]
  /** 关系图用的全量项目任务，不受按日筛选影响。 */
  graphTasks: Task[]
  /** 关系图里手动拖过的顶层节点位置，按项目存在浏览器本地。 */
  graphPositions: GraphPositions
  view: TaskView
  selectedProjectId: string | null
  statusFilter: TaskStatus | null
  dayCounts: DayCount[]
  dayFilter: string[]
  projectsLoading: boolean
  projectsError: boolean
  tasksLoading: boolean
  graphLoading: boolean
  detail: DetailState | null
  projectEditing: ProjectEditing | null

  bootstrap: () => Promise<void>
  selectProject: (id: string) => Promise<void>
  setView: (view: TaskView) => Promise<void>
  toggleStatusFilter: (status: TaskStatus) => void
  toggleDayFilter: (date: string) => Promise<void>
  setDayFilter: (dates: string[]) => Promise<void>
  refreshDayCounts: () => Promise<void>
  refreshProjects: () => Promise<void>
  refreshTasks: (clear?: boolean) => Promise<void>
  refreshGraph: () => Promise<void>
  refreshAll: () => Promise<void>
  openTask: (task: Task) => void
  openNewTask: () => void
  closeDetail: () => void
  saveTask: (draft: TaskDraft) => Promise<void>
  removeTask: (id: string) => Promise<void>
  moveTask: (task: Task, target: MoveTarget, blockedReason?: string) => Promise<void>
  /** 关系图里的关系写入，`null` 表示解除；`parent_id` 与 `pre_id` 都走这里。 */
  setTaskParent: (id: string, parentId: string | null) => Promise<void>
  setTaskPredecessor: (id: string, preId: string | null) => Promise<void>
  setGraphPosition: (id: string, point: GraphPoint) => void
  resetGraphPosition: (id: string) => void
  clearGraphPositions: () => void
  startCreateProject: () => void
  startEditProject: (id: string) => void
  cancelProjectForm: () => void
  saveProject: (id: string | null, input: ProjectInput) => Promise<void>
  removeProject: (id: string) => Promise<void>
}

let tasksRequestId = 0
let graphRequestId = 0

export const useTodoStore = create<TodoState>((set, get) => ({
  projects: [],
  tasks: [],
  graphTasks: [],
  graphPositions: {},
  view: readStoredView(),
  selectedProjectId: null,
  statusFilter: null,
  dayCounts: [],
  dayFilter: [],
  projectsLoading: true,
  projectsError: false,
  tasksLoading: false,
  graphLoading: false,
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
      graphTasks: [],
      graphPositions: {},
      detail: null,
      projectEditing: null,
    })
    const loads: Array<Promise<void>> = [get().refreshTasks(true), get().refreshDayCounts()]
    if (get().view === 'graph') loads.push(get().refreshGraph())
    await Promise.all(loads)
  },

  setView: async (view) => {
    if (get().view === view) return
    set({ view })
    localStorage.setItem(VIEW_KEY, view)
    if (view === 'graph') await get().refreshGraph()
  },

  toggleStatusFilter: (status) => {
    set({ statusFilter: get().statusFilter === status ? null : status })
  },

  toggleDayFilter: async (date) => {
    const current = get().dayFilter
    await get().setDayFilter(
      current.includes(date) ? current.filter((day) => day !== date) : [...current, date],
    )
  },

  setDayFilter: async (dates) => {
    set({ dayFilter: dates })
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
        dates: dayFilter,
      })
      if (requestId !== tasksRequestId) return
      set({ tasks, tasksLoading: false })
    } catch (error) {
      if (requestId === tasksRequestId) set({ tasksLoading: false })
      throw error
    }
  },

  refreshAll: async () => {
    const loads: Array<Promise<void>> = [
      get().refreshProjects(),
      get().refreshTasks(),
      get().refreshDayCounts(),
    ]
    if (get().view === 'graph') loads.push(get().refreshGraph())
    await Promise.all(loads)
  },

  refreshGraph: async () => {
    const { selectedProjectId } = get()
    if (!selectedProjectId) {
      set({ graphTasks: [], graphPositions: {}, graphLoading: false })
      return
    }
    const requestId = ++graphRequestId
    set({ graphLoading: true })
    try {
      // 关系图要看见完整的父子与前置链，不能带按日筛选。
      const { tasks } = await api.listTasks({ project: selectedProjectId })
      if (requestId !== graphRequestId) return
      set({
        graphTasks: tasks,
        graphPositions: readPositions(selectedProjectId),
        graphLoading: false,
      })
    } catch (error) {
      if (requestId === graphRequestId) set({ graphLoading: false })
      throw error
    }
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
        log: draft.log,
        result: draft.result,
      })
    } else {
      await api.createTask({
        title: draft.title,
        priority: draft.priority,
        tags: draft.tags,
        project_id: get().selectedProjectId,
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

  /** 把 `parentId` 设为任务的父任务；传 `null` 解除父子关系。 */
  setTaskParent: async (id, parentId) => {
    const tasks = get().graphTasks
    const task = tasks.find((item) => item.id === id)
    if (!task) throw new Error('Task is not in the current graph')
    if ((task.parent_id ?? null) === parentId) return
    if (parentId !== null && relationCreatesCycle(tasks, 'parent', parentId, id)) {
      throw new Error('That would create a loop in the parent chain')
    }
    await api.updateTask(id, { parent_id: parentId })
    await get().refreshAll()
  },

  /** 把 `preId` 设为任务的前置任务；传 `null` 解除前置依赖。 */
  setTaskPredecessor: async (id, preId) => {
    const tasks = get().graphTasks
    const task = tasks.find((item) => item.id === id)
    if (!task) throw new Error('Task is not in the current graph')
    if ((task.pre_id ?? null) === preId) return
    if (preId !== null && relationCreatesCycle(tasks, 'pre', preId, id)) {
      throw new Error('That would create a loop in the prerequisites')
    }
    await api.updateTask(id, { pre_id: preId })
    await get().refreshAll()
  },

  /** 记录一个顶层节点的手动位置；顺带丢掉已经不在图里的坐标。 */
  setGraphPosition: (id, point) => {
    const projectId = get().selectedProjectId
    if (!projectId) return
    const alive = new Set(get().graphTasks.map((task) => task.id))
    const next: GraphPositions = {}
    for (const [key, value] of Object.entries(get().graphPositions)) {
      if (alive.has(key)) next[key] = value
    }
    next[id] = point
    set({ graphPositions: next })
    writePositions(projectId, next)
  },

  resetGraphPosition: (id) => {
    const projectId = get().selectedProjectId
    if (!projectId || !get().graphPositions[id]) return
    const next = { ...get().graphPositions }
    delete next[id]
    set({ graphPositions: next })
    writePositions(projectId, next)
  },

  clearGraphPositions: () => {
    const projectId = get().selectedProjectId
    if (!projectId) return
    set({ graphPositions: {} })
    writePositions(projectId, {})
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
