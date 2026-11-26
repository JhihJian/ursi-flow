import { useEffect, useRef, type ReactNode } from 'react'
import type { WorkspaceModule } from '@ursi/workspace-shell'
import { useWorkspace } from '@ursi/workspace-shell'
import { TodoSidebar } from './components/TodoSidebar'
import { TodoWorkspace } from './components/TodoWorkspace'
import { TodoProvider } from './providers'
import { useTodoStore } from './store/todo-store'
import { buildTaskMarkdown } from './lib/task-markdown'
import { copyText } from './lib/clipboard'

/** todo 模块对外暴露的接入代码：宿主只负责调用工厂登记，不实现模块逻辑。 */

const KIND = 'todo.task'

/**
 * 跨模块能力由组合根注入，todo 只声明它需要的形状，不 import 任何其它模块。
 * 缺省不注入时，对应的操作给出禁用原因而不是静默消失。
 */
export interface TodoModuleOptions {
  /** 按目录绝对路径在文件模块里打开；返回该目录在文件模块里的标识。 */
  openRootInFiles?: (root: string) => Promise<{ id: string; label: string }>
}

function projectPathOf(projectId: string | null | undefined): string | null {
  if (!projectId) return null
  const project = useTodoStore.getState().projects.find((item) => item.id === projectId)
  return project?.path ?? null
}

function useSelectedTask() {
  return useTodoStore((state) => (state.detail?.mode === 'view' ? state.detail.task : null))
}

/** 把模块内的任务选中同步到外壳；侧边栏、工作区、状态栏读同一份。 */
function TodoSelectionBridge() {
  const { selection, select } = useWorkspace()
  const task = useSelectedTask()
  // 只清自己发布的选中，避免模块挂载时抹掉别的模块的选中。
  const current = useRef(selection)
  current.current = selection

  useEffect(() => {
    if (task) select({ kind: KIND, id: task.id, label: task.title })
    else if (current.current?.kind === KIND) select(null)
  }, [task, select])

  return null
}

/** 状态栏：待办数量与当前选中任务。 */
function TodoStatus() {
  const tasks = useTodoStore((state) => state.tasks)
  const { selection } = useWorkspace()
  const pending = tasks.filter((task) => task.status === 'pending').length
  const selected = selection?.kind === KIND ? (selection.label ?? selection.id) : ''
  return (
    <span>
      待办 {pending}
      {selected ? ` · ${selected}` : ''}
    </span>
  )
}

function selectedTaskFrom(selection: { id: string }) {
  return useTodoStore.getState().tasks.find((item) => item.id === selection.id) ?? null
}

export function createTodoModule(options: TodoModuleOptions = {}): WorkspaceModule {
  const { openRootInFiles } = options
  const Provider = ({ children }: { children: ReactNode }) => (
    <TodoProvider>
      <TodoSelectionBridge />
      {children}
    </TodoProvider>
  )

  return {
    id: 'todo',
    title: 'Todo',
    Provider,
    Sidebar: TodoSidebar,
    Workspace: TodoWorkspace,
    context: {
      kind: KIND,
      summary: (selection) => selection.label ?? `Task ${selection.id}`,
      Status: TodoStatus,
    },
    sidebarDefaultSize: 320,
    sidebarMinSize: 180,
    sidebarMaxSize: 560,
    actions: [
      {
        id: 'open-project-in-files',
        label: '在文件模块打开项目目录',
        appliesTo: (selection) => selection?.kind === KIND,
        disabledReason: (selection, shell) => {
          if (!openRootInFiles) return '组合根未接入文件模块能力'
          if (!shell.enabled('fs-web')) return '文件模块未在当前 profile 中启用'
          const task = selectedTaskFrom(selection)
          if (!task) return '任务不在当前列表里'
          if (!projectPathOf(task.project_id)) return '该项目未设置目录'
          return null
        },
        confirm: (selection) => {
          const task = selectedTaskFrom(selection)
          const root = projectPathOf(task?.project_id) ?? ''
          return `会在文件模块里登记并打开目录\n${root}\n继续？`
        },
        run: async (selection, shell) => {
          if (!openRootInFiles) throw new Error('组合根未接入文件模块能力')
          const task = selectedTaskFrom(selection)
          if (!task) throw new Error('任务不在当前列表里')
          const root = projectPathOf(task.project_id)
          if (!root) throw new Error('该项目未设置目录')
          await openRootInFiles(root)
          shell.reveal('fs-web')
        },
      },
      {
        id: 'copy-markdown',
        label: '复制为 Markdown',
        appliesTo: (selection) => selection?.kind === KIND,
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
