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

export function createTodoModule(): WorkspaceModule {
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
            note: task.result ?? '',
            timeInfo: null,
          })
          await copyText(markdown)
        },
      },
    ],
  }
}
