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
  /** 新建任务的详情面板；带 parentId 时保存后直接成为该任务的子任务。 */
  | { mode: 'new'; parentId: string | null }

export interface ProjectEditing {
  /** null 表示新建项目。 */
  id: string | null
}

export type MoveTarget = { status: TaskStatus } | { projectId: string }

/** 状态迁移时必须同时提交的字段。 */
export interface StatusInput {
  result?: string
  blockedReason?: string
}

/** 需要用户补填一段文字时的弹窗描述。 */
export interface TextPromptOptions {
  title: string
  label: string
  confirmLabel: string
  placeholder?: string
  /** 是否多行输入；多行时 Ctrl+Enter 提交。 */
  multiline?: boolean
  /** 空输入时的提示，未提供则允许空文本。 */
  requiredMessage?: string
}

export interface TextPromptState {
  id: number
  options: TextPromptOptions
  settle: (value: string | null) => void
}

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
  /** 完成结果、阻塞原因等一次性输入，全应用共用一个弹窗。 */
  textPrompt: TextPromptState | null

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
  openNewTaskUnder: (parentId: string) => void
  closeDetail: () => void
  saveTask: (draft: TaskDraft) => Promise<void>
  removeTask: (id: string) => Promise<void>
  moveTask: (task: Task, target: MoveTarget, blockedReason?: string) => Promise<void>
  /** 关系图里直接切换状态，`done` 需要 result、`blocked` 需要 reason。 */
  setTaskStatus: (id: string, status: TaskStatus, input?: StatusInput) => Promise<void>
  /** 弹出输入框等一段文字；取消或关闭时得到 `null`。 */
  requestText: (options: TextPromptOptions) => Promise<string | null>
  settleTextPrompt: (value: string | null) => void
  /** 图操作撤销栈：每项是能恢复上一次写入的异步动作，切换项目时清空。 */
  graphUndo: Array<() => Promise<void>>
  /** 关系图里按 Ctrl+Z 撤销上一次图操作（关系与状态写入）。 */
  undoGraphAction: () => Promise<void>
  /** 撤销回放用的直接写入：不做环检查，也不记录撤销。 */
  applyGraphUpdate: (
    id: string,
    input: Parameters<typeof api.updateTask>[1],
  ) => Promise<void>
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
let promptId = 0

const GRAPH_UNDO_LIMIT = 30

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
  textPrompt: null,
  graphUndo: [],

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
      graphUndo: [],
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
      detail: { mode: 'new', parentId: null },
      projectEditing: null,
    }),

  openNewTaskUnder: (parentId) =>
    set({
      detail: { mode: 'new', parentId },
      projectEditing: null,
    }),

  closeDetail: () => set({ detail: null }),

  saveTask: async (draft) => {
    const detail = get().detail
    const parentId = detail?.mode === 'new' ? detail.parentId : null
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
        ...(parentId === null ? {} : { parent_id: parentId }),
        // 新建时详情面板里填的记录与结果一起提交，避免保存后再补一次。
        ...(draft.log ? { log: draft.log } : {}),
        ...(draft.result ? { result: draft.result } : {}),
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

  setTaskStatus: async (id, status, input = {}) => {
    const task =
      get().graphTasks.find((item) => item.id === id) ??
      get().tasks.find((item) => item.id === id)
    if (!task || task.status === status) return
    // 完成与阻塞的必填字段跟着状态一起提交，避免服务端因缺字段拒绝。
    await api.updateTask(id, {
      status,
      ...(status === 'done' ? { result: input.result ?? '' } : {}),
      ...(status === 'blocked' ? { blocked_reason: input.blockedReason ?? '' } : {}),
    })
    // 撤销需要恢复原状态与对应的必填字段；涉及取消的迁移不可逆，不记录。
    if (task.status !== 'cancelled' && status !== 'cancelled') {
      const previous = {
        status: task.status,
        blockedReason: task.blocked_reason ?? '',
        result: task.result ?? '',
      }
      set((state) => ({
        graphUndo: [
          ...state.graphUndo.slice(-(GRAPH_UNDO_LIMIT - 1)),
          () =>
            get().applyGraphUpdate(id, {
              status: previous.status,
              ...(previous.status === 'blocked'
                ? { blocked_reason: previous.blockedReason }
                : {}),
              ...(previous.status === 'done' ? { result: previous.result } : {}),
            }),
        ],
      }))
    }
    const detail = get().detail
    if (detail?.mode === 'view' && detail.task.id === id) set({ detail: null })
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
    const previous = task.parent_id ?? null
    await api.updateTask(id, { parent_id: parentId })
    set((state) => ({
      graphUndo: [
        ...state.graphUndo.slice(-(GRAPH_UNDO_LIMIT - 1)),
        () => get().applyGraphUpdate(id, { parent_id: previous }),
      ],
    }))
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
    const previous = task.pre_id ?? null
    await api.updateTask(id, { pre_id: preId })
    set((state) => ({
      graphUndo: [
        ...state.graphUndo.slice(-(GRAPH_UNDO_LIMIT - 1)),
        () => get().applyGraphUpdate(id, { pre_id: previous }),
      ],
    }))
    await get().refreshAll()
  },

  undoGraphAction: async () => {
    const stack = get().graphUndo
    if (stack.length === 0) return
    set({ graphUndo: stack.slice(0, -1) })
    await stack[stack.length - 1]()
  },

  applyGraphUpdate: async (id, input) => {
    await api.updateTask(id, input)
    await get().refreshAll()
  },

  requestText: (options) =>
    new Promise((resolve) => {
      // 同时只保留一个输入请求，旧请求按取消处理。
      get().settleTextPrompt(null)
      promptId += 1
      set({ textPrompt: { id: promptId, options, settle: resolve } })
    }),

  settleTextPrompt: (value) => {
    const prompt = get().textPrompt
    if (!prompt) return
    set({ textPrompt: null })
    prompt.settle(value)
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
