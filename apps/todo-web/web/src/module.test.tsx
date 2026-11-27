import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { WorkspaceProvider, useWorkspace } from '@ursi/workspace-shell'
import type { Selection, ShellHandle, WorkspaceAction } from '@ursi/workspace-shell'
import { createTodoModule, TodoSelectionBridge } from './module'
import { useTodoStore } from './store/todo-store'

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
  getStats: vi.fn(),
}))

function project(id: string, path: string | null) {
  return {
    id,
    name: `Project ${id}`,
    created_at: '2026-03-01T09:00:00Z',
    description: null,
    path,
    task_count: { pending: 0, in_progress: 0, blocked: 0, done: 0, cancelled: 0 },
    total_time_minutes: 0,
  }
}

function task(id: string, projectId: string | null) {
  return {
    id,
    title: `Task ${id}`,
    creator: 'human' as const,
    created_at: '2026-03-01T09:00:00Z',
    priority: 'high' as const,
    artifacts: [],
    status: 'pending' as const,
    tags: [],
    project_id: projectId,
  }
}

function shellWith(enabled: string[]): ShellHandle {
  const set = new Set(enabled)
  return {
    enabled: (id) => set.has(id),
    reveal: vi.fn(),
  }
}

/** todo 的动作确认文案都是函数形式，这里按契约取出来调用。 */
function confirmText(action: WorkspaceAction, selection: Selection, shell: ShellHandle): string {
  if (typeof action.confirm !== 'function') throw new Error('confirm 应为函数形式')
  return action.confirm(selection, shell)
}

afterEach(() => {
  cleanup()
})

const taskSelection = (id: string): Selection => ({ kind: 'todo.task', id })
const projectSelection = (id: string): Selection => ({ kind: 'todo.project', id })

beforeEach(() => {
  useTodoStore.setState({
    projects: [project('local', 'file:///data/dev/x'), project('remote', 'ssh://nm105/srv/proj')],
    tasks: [task('t-local', 'local'), task('t-remote', 'remote')],
    selectedProjectId: null,
    detail: null,
    projectEditing: null,
  })
})

describe('在文件模块打开项目目录', () => {
  it('任务与项目两种选中都适用', () => {
    const action = createTodoModule().actions!.find((item) => item.id === 'open-project-in-files')!
    expect(action.appliesTo(taskSelection('t-local'), shellWith([]))).toBe(true)
    expect(action.appliesTo(projectSelection('local'), shellWith([]))).toBe(true)
    expect(action.appliesTo({ kind: 'workspace.file', id: 'x' }, shellWith([]))).toBe(false)
  })

  it('经任务反查项目，确认文案显示位置 URI', () => {
    const action = createTodoModule({ openRootInFiles: vi.fn() }).actions!.find(
      (item) => item.id === 'open-project-in-files',
    )!
    expect(confirmText(action, taskSelection('t-remote'), shellWith(['fs-web', 'ssh']))).toBe(
      '会在文件模块里登记并打开目录\nssh://nm105/srv/proj\n继续？',
    )
  })

  it('任务被筛选出列表但详情还开着时，仍能经详情反查到项目', () => {
    const action = createTodoModule({ openRootInFiles: vi.fn() }).actions!.find(
      (item) => item.id === 'open-project-in-files',
    )!
    // 列表里只剩本机任务，但详情面板还停在远程任务上。
    useTodoStore.setState({ tasks: [task('t-local', 'local')], detail: { mode: 'view', task: task('t-remote', 'remote') } })
    expect(action.disabledReason!(taskSelection('t-remote'), shellWith(['fs-web', 'ssh']))).toBeNull()
    expect(confirmText(action, taskSelection('t-remote'), shellWith(['fs-web', 'ssh']))).toContain(
      'ssh://nm105/srv/proj',
    )
  })

  it('远程目录在 ssh 模块未启用时给出禁用原因', () => {
    const action = createTodoModule({ openRootInFiles: vi.fn() }).actions!.find(
      (item) => item.id === 'open-project-in-files',
    )!
    expect(action.disabledReason!(projectSelection('remote'), shellWith(['fs-web']))).toBe(
      '远程目录需要 SSH 模块',
    )
    expect(action.disabledReason!(projectSelection('remote'), shellWith(['fs-web', 'ssh']))).toBeNull()
    // 本机目录不需要 ssh 模块。
    expect(action.disabledReason!(projectSelection('local'), shellWith(['fs-web']))).toBeNull()
  })

  it('运行时把 URI 原样交给文件模块', async () => {
    const openRootInFiles = vi.fn(async () => ({ id: 'w', label: 'l' }))
    const action = createTodoModule({ openRootInFiles }).actions!.find(
      (item) => item.id === 'open-project-in-files',
    )!
    const shell = shellWith(['fs-web', 'ssh'])
    await action.run(projectSelection('remote'), shell)
    expect(openRootInFiles).toHaveBeenCalledWith('ssh://nm105/srv/proj')
    expect(shell.reveal).toHaveBeenCalledWith('fs-web')
  })
})

describe('在此打开终端', () => {
  const openTerminal = vi.fn(async () => {})

  function terminalAction() {
    return createTodoModule({ host: { openTerminal } }).actions!.find(
      (item) => item.id === 'open-terminal-here',
    )!
  }

  it('本机项目不适用，远程项目适用，任务选中不适用', () => {
    const action = terminalAction()
    expect(action.appliesTo(projectSelection('local'), shellWith(['ssh']))).toBe(false)
    expect(action.appliesTo(projectSelection('remote'), shellWith(['ssh']))).toBe(true)
    // 任务选中即使属于远程项目也不出这个动作，动作绑在项目选中上。
    expect(action.appliesTo(taskSelection('t-remote'), shellWith(['ssh']))).toBe(false)
  })

  it('未注入 openTerminal 或 ssh 模块未启用时给出禁用原因', () => {
    const shell = shellWith(['ssh'])
    const bare = createTodoModule().actions!.find((item) => item.id === 'open-terminal-here')!
    expect(bare.disabledReason!(projectSelection('remote'), shell)).toBe('组合根未接入 SSH 模块能力')

    expect(terminalAction().disabledReason!(projectSelection('remote'), shellWith([]))).toBe(
      'SSH 模块未在当前 profile 中启用',
    )
    expect(terminalAction().disabledReason!(projectSelection('remote'), shell)).toBeNull()
  })

  it('确认文案带出设备与路径，运行后展开 ssh 模块', async () => {
    openTerminal.mockClear()
    const action = terminalAction()
    const shell = shellWith(['ssh'])
    expect(confirmText(action, projectSelection('remote'), shell)).toBe(
      '会在设备 nm105 上打开终端并进入\n/srv/proj\n继续？',
    )
    await action.run(projectSelection('remote'), shell)
    expect(openTerminal).toHaveBeenCalledWith({ device: 'nm105', cwd: '/srv/proj' })
    expect(shell.reveal).toHaveBeenCalledWith('ssh')
  })
})

describe('选中桥接', () => {
  it('两种 kind 都归 todo，状态栏与清空逻辑认它们', () => {
    // 直接验证常量口径：复制 Markdown 只认任务，不认项目。
    const action = createTodoModule().actions!.find((item) => item.id === 'copy-markdown')!
    expect(action.appliesTo(taskSelection('t-local'), shellWith([]))).toBe(true)
    expect(action.appliesTo(projectSelection('local'), shellWith([]))).toBe(false)
  })
})

describe('选中桥接', () => {
  function Probe() {
    const { selection } = useWorkspace()
    seen.push(selection)
    return null
  }

  let seen: Array<Selection | null> = []

  function renderBridge() {
    seen = []
    render(
      <WorkspaceProvider>
        <TodoSelectionBridge />
        <Probe />
      </WorkspaceProvider>,
    )
    return seen
  }

  it('有任务详情时发布任务，关掉后回退到当前项目，没有项目时清空', async () => {
    useTodoStore.setState({
      selectedProjectId: 'local',
      detail: { mode: 'view', task: task('t-local', 'local') },
    })
    const seen = renderBridge()
    expect(seen.at(-1)).toEqual({ kind: 'todo.task', id: 't-local', label: 'Task t-local' })

    act(() => useTodoStore.setState({ detail: null }))
    expect(seen.at(-1)).toEqual({ kind: 'todo.project', id: 'local', label: 'Project local' })

    act(() => useTodoStore.setState({ selectedProjectId: null }))
    expect(seen.at(-1)).toBeNull()
  })

  it('没有任务与项目时，不抹掉别的模块发布的选中', async () => {
    useTodoStore.setState({ selectedProjectId: null, detail: null })
    function Seed() {
      // 模拟别的模块先发布选中，再挂上 todo 的桥接。
      const { select } = useWorkspace()
      const [seeded, setSeeded] = useState(false)
      useEffect(() => {
        if (seeded) return
        setSeeded(true)
        select({ kind: 'workspace.file', id: 'f1' })
      }, [seeded, select])
      return null
    }
    render(
      <WorkspaceProvider>
        <Seed />
        <TodoSelectionBridge />
        <Probe />
      </WorkspaceProvider>,
    )
    await act(async () => {})
    expect(seen.at(-1)).toEqual({ kind: 'workspace.file', id: 'f1' })
  })
})
