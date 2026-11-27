import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import type { WorkspaceModule } from '@ursi/workspace-shell'
import { useWorkspace } from '@ursi/workspace-shell'
import type { ListDirFn } from '@ursi/directory-picker'
import { parse } from '@ursi/location'
import { TodoSidebar } from './components/TodoSidebar'
import { TodoWorkspace } from './components/TodoWorkspace'
import { TodoProvider } from './providers'
import { useTodoStore } from './store/todo-store'
import { buildTaskMarkdown } from './lib/task-markdown'
import { copyText } from './lib/clipboard'

/** todo 模块对外暴露的接入代码：宿主只负责调用工厂登记，不实现模块逻辑。 */

const TASK_KIND = 'todo.task'
const PROJECT_KIND = 'todo.project'
/** 本模块发布的两种选中类型，清空选中时只认这两个。 */
const OWNED_KINDS: ReadonlySet<string> = new Set([TASK_KIND, PROJECT_KIND])

/**
 * 组合根注入给 todo 的能力：todo 不访问任何文件系统，选目录器的数据与设备清单、
 * 「在此打开终端」都由接收方提供。不传时对应入口不显示或给出禁用原因。
 */
export interface TodoHostBindings {
  /** 选目录器的数据源，通常是 fs-web 的 `commands.browse`。不传则项目编辑面板只有手输。 */
  listDir?: ListDirFn
  /** 可切换的远程设备清单，通常是 ssh-web 的 `commands.listDevices`。不传则选目录器只有本机。 */
  devices?: () => Promise<Array<{ device: string; label: string }>>
  /** 在远程设备的某目录打开终端，通常是 ssh-web 的 `commands.openTerminal`。 */
  openTerminal?: (target: { device: string; cwd: string }) => Promise<void>
}

/**
 * 跨模块能力由组合根注入，todo 只声明它需要的形状，不 import 任何其它模块。
 * 缺省不注入时，对应的操作给出禁用原因而不是静默消失。
 */
export interface TodoModuleOptions {
  /** 按位置 URI（`file:///abs`、`ssh://<设备>/abs`，旧数据可能是裸路径简写）在文件模块里打开；返回该目录在文件模块里的标识。 */
  openRootInFiles?: (root: string) => Promise<{ id: string; label: string }>
  host?: TodoHostBindings
}

const NO_HOST: TodoHostBindings = {}

/**
 * host 走 React context 而不是 zustand store：store 里不放函数。
 * 工厂里固定引用，组合根每次渲染传新对象也不会让组件误以为能力变了。
 */
const TodoHostContext = createContext<TodoHostBindings>(NO_HOST)

/** 把组合根注入的能力提供给 todo 的组件；工厂的 Provider 与测试都用它。 */
export function TodoHostProvider({
  host,
  children,
}: {
  host: TodoHostBindings
  children: ReactNode
}) {
  return <TodoHostContext.Provider value={host}>{children}</TodoHostContext.Provider>
}

/** 组件读取组合根注入的能力；独立页面里恒为空对象。 */
export function useTodoHost(): TodoHostBindings {
  return useContext(TodoHostContext)
}

function projectOf(projectId: string | null | undefined) {
  if (!projectId) return undefined
  return useTodoStore.getState().projects.find((item) => item.id === projectId)
}

/** 选中对应的项目：`todo.project` 直接取，`todo.task` 经任务反查（当前详情优先，再查列表）。 */
function projectFrom(selection: { kind: string; id: string }) {
  if (selection.kind === PROJECT_KIND) return projectOf(selection.id)
  if (selection.kind !== TASK_KIND) return undefined
  const state = useTodoStore.getState()
  const task =
    state.detail?.mode === 'view' && state.detail.task.id === selection.id
      ? state.detail.task
      : state.tasks.find((item) => item.id === selection.id)
  return projectOf(task?.project_id)
}

function selectedTaskFrom(selection: { id: string }) {
  return useTodoStore.getState().tasks.find((item) => item.id === selection.id) ?? null
}

/** 两种选中都用得到的项目目录：没有项目或没设目录返回 null。 */
function projectPathFrom(selection: { kind: string; id: string }): string | null {
  return projectFrom(selection)?.path ?? null
}

function useSelectedTask() {
  return useTodoStore((state) => (state.detail?.mode === 'view' ? state.detail.task : null))
}

function useSelectedProject() {
  const selectedProjectId = useTodoStore((state) => state.selectedProjectId)
  const projects = useTodoStore((state) => state.projects)
  return projects.find((item) => item.id === selectedProjectId)
}

/**
 * 把模块内的选中同步到外壳；侧边栏、工作区、状态栏读同一份。
 * 任务详情打开时发布 `todo.task`，否则发布当前项目的 `todo.project`，
 * 这样项目没有任务时「打开项目目录」「在此打开终端」依然能触发。
 * 只依赖 store 与外壳的选中，不依赖 TodoProvider，可单独挂载验证。
 */
export function TodoSelectionBridge() {
  const { selection, select } = useWorkspace()
  const task = useSelectedTask()
  const project = useSelectedProject()
  // 只清自己发布的选中，避免模块挂载时抹掉别的模块的选中。
  const current = useRef(selection)
  current.current = selection

  useEffect(() => {
    if (task) select({ kind: TASK_KIND, id: task.id, label: task.title })
    else if (project) select({ kind: PROJECT_KIND, id: project.id, label: project.name })
    else if (OWNED_KINDS.has(current.current?.kind ?? '')) select(null)
  }, [task, project, select])

  return null
}

/** 状态栏：待办数量与当前选中（任务或项目）。 */
function TodoStatus() {
  const tasks = useTodoStore((state) => state.tasks)
  const { selection } = useWorkspace()
  const pending = tasks.filter((task) => task.status === 'pending').length
  const selected =
    selection && OWNED_KINDS.has(selection.kind) ? (selection.label ?? selection.id) : ''
  return (
    <span>
      待办 {pending}
      {selected ? ` · ${selected}` : ''}
    </span>
  )
}

export function createTodoModule(options: TodoModuleOptions = {}): WorkspaceModule {
  const { openRootInFiles } = options
  const host: TodoHostBindings = options.host ?? NO_HOST
  const Provider = ({ children }: { children: ReactNode }) => (
    <TodoHostProvider host={host}>
      <TodoProvider>
        <TodoSelectionBridge />
        {children}
      </TodoProvider>
    </TodoHostProvider>
  )

  return {
    id: 'todo',
    title: 'Todo',
    Provider,
    Sidebar: TodoSidebar,
    Workspace: TodoWorkspace,
    context: {
      kind: TASK_KIND,
      summary: (selection) => selection.label ?? `Task ${selection.id}`,
      Status: TodoStatus,
    },
    actions: [
      {
        id: 'open-project-in-files',
        label: '在文件模块打开项目目录',
        appliesTo: (selection) => selection !== null && (selection.kind === TASK_KIND || selection.kind === PROJECT_KIND),
        disabledReason: (selection, shell) => {
          if (!openRootInFiles) return '组合根未接入文件模块能力'
          if (!shell.enabled('fs-web')) return '文件模块未在当前 profile 中启用'
          const project = projectFrom(selection)
          if (!project) {
            return selection.kind === TASK_KIND ? '任务不在当前列表里' : '项目不在当前列表里'
          }
          const path = project.path
          if (!path) return '该项目未设置目录'
          // 远程目录要经 ssh 设备打开，文件模块自己不连设备。解析不了的旧值不在这一步拦，交给文件模块报错。
          if (locationOfPath(path)?.scheme === 'ssh' && !shell.enabled('ssh')) return '远程目录需要 SSH 模块'
          return null
        },
        confirm: (selection) => {
          const path = projectPathFrom(selection) ?? ''
          return `会在文件模块里登记并打开目录\n${path}\n继续？`
        },
        run: async (selection, shell) => {
          if (!openRootInFiles) throw new Error('组合根未接入文件模块能力')
          const project = projectFrom(selection)
          if (!project) {
            throw new Error(selection.kind === TASK_KIND ? '任务不在当前列表里' : '项目不在当前列表里')
          }
          const root = project.path
          if (!root) throw new Error('该项目未设置目录')
          await openRootInFiles(root)
          shell.reveal('fs-web')
        },
      },
      {
        id: 'open-terminal-here',
        label: '在此打开终端',
        // 只有选中项目且目录在远程设备上才显示；本机项目与目录无法解析的项目不出这个动作。
        appliesTo: (selection) =>
          selection !== null && selection.kind === PROJECT_KIND && locationOfProject(selection)?.scheme === 'ssh',
        disabledReason: (selection, shell) => {
          if (!host.openTerminal) return '组合根未接入 SSH 模块能力'
          if (!shell.enabled('ssh')) return 'SSH 模块未在当前 profile 中启用'
          const location = locationOfProject(selection)
          if (!location) return '该项目未设置有效的远程目录'
          return null
        },
        confirm: (selection) => {
          const location = locationOfProject(selection)
          return `会在设备 ${location?.device ?? ''} 上打开终端并进入\n${location?.path ?? ''}\n继续？`
        },
        run: async (selection, shell) => {
          if (!host.openTerminal) throw new Error('组合根未接入 SSH 模块能力')
          const location = locationOfProject(selection)
          // 动作只在远程项目上出现；走到这里没有设备名说明选中已变，按错误处理而不是静默打开本机。
          if (!location?.device) throw new Error('该项目未设置有效的远程目录')
          await host.openTerminal({ device: location.device, cwd: location.path })
          shell.reveal('ssh')
        },
      },
      {
        id: 'copy-markdown',
        label: '复制为 Markdown',
        appliesTo: (selection) => selection?.kind === TASK_KIND,
        run: async (selection) => {
          const task = selectedTaskFrom(selection)
          if (!task) throw new Error('任务不在当前列表里')
          const markdown = buildTaskMarkdown({
            title: task.title,
            status: task.status,
            priority: task.priority,
            tags: task.tags,
            log: task.log ?? '',
            result: task.result ?? '',
            timeInfo: null,
          })
          await copyText(markdown)
        },
      },
    ],
  }
}

/** 把一个目录字符串解析成位置；裸路径按本机简写解析，非法输入返回 null。 */
function locationOfPath(path: string) {
  try {
    return parse(path)
  } catch {
    return null
  }
}

/** 项目目录对应的位置；没有项目、没设目录或目录非法时返回 null。 */
function locationOfProject(selection: { kind: string; id: string }) {
  const path = projectPathFrom(selection)
  return path ? locationOfPath(path) : null
}
