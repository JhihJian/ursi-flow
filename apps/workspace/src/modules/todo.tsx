import { useEffect } from 'react'
import type { CollapsedSummary, Selection, WorkspaceModule } from '@ursi/workspace-shell'
import { useWorkspace } from '@ursi/workspace-shell'
import TodoApp from '@todo/App'
import { useTodoStore } from '@todo/store/todo-store'
import { buildTaskMarkdown } from '@todo/lib/task-markdown'
import { copyText } from '@todo/lib/clipboard'

const KIND = 'todo.task'

function useSelectedTask() {
  return useTodoStore((state) => (state.detail?.mode === 'view' ? state.detail.task : null))
}

/**
 * todo 模块的展开态。内部仍是完整的 todo 应用，同时把「选中了哪个任务」
 * 同步给工作区外壳，供工作区区域与右侧操作面板使用。
 */
function TodoPanel() {
  const { select } = useWorkspace()
  const task = useSelectedTask()

  useEffect(() => {
    select(task ? { kind: KIND, id: task.id, label: task.title } : null)
  }, [task, select])

  return (
    <div className="todo-embed">
      <TodoApp />
    </div>
  )
}

/**
 * 折叠后由外壳排版，这里只公布关键信息：当前任务与状态、所属项目，未选中时给任务数。
 * 折叠 UI 不归 todo 维护。
 */
function useCollapsedSummary(): CollapsedSummary {
  const task = useSelectedTask()
  const tasks = useTodoStore((state) => state.tasks)
  const projects = useTodoStore((state) => state.projects)
  const project = task?.project_id
    ? projects.find((candidate) => candidate.id === task.project_id)
    : undefined

  if (!task) {
    return {
      title: 'Tasks',
      items: [{ label: 'count', value: String(tasks.length) }],
    }
  }
  return {
    title: task.title,
    items: [
      { label: 'status', value: task.status },
      ...(project ? [{ label: 'project', value: project.name }] : []),
    ],
  }
}

function TodoWorkspaceView({ selection }: { selection: Selection }) {
  const task = useTodoStore((state) => state.tasks.find((item) => item.id === selection.id))
  const projects = useTodoStore((state) => state.projects)
  const project = task?.project_id
    ? projects.find((candidate) => candidate.id === task.project_id)
    : undefined

  if (!task) {
    return (
      <div className="ws-placeholder">
        <span className="ws-placeholder-title">Task</span>
        <span className="ws-placeholder-text">该任务不在当前筛选结果里，切回全部状态后可见。</span>
      </div>
    )
  }

  const rows: Array<[string, string]> = [
    ['Project', project?.name ?? '-'],
    ['Status', task.status],
    ['Priority', task.priority],
    ['Tags', task.tags.length ? task.tags.map((tag) => `#${tag}`).join(' ') : '-'],
    ['Workdir', task.workspace ?? '-'],
    ['Session', task.session_id ?? '-'],
  ]

  return (
    <div className="todo-view">
      <h2 className="todo-view-title">{task.title}</h2>
      <dl className="todo-view-meta">
        {rows.map(([label, value]) => (
          <div key={label} className="todo-view-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="todo-view-hint">
        执行集成、制品与事件后续在这里接入；工作区外壳只按选中类型分派视图。
      </p>
    </div>
  )
}

function selectedTaskFrom(selection: Selection) {
  return useTodoStore.getState().tasks.find((item) => item.id === selection.id) ?? null
}

export function createTodoModule(): WorkspaceModule {
  return {
    id: 'todo',
    title: 'Todo',
    // todo 自带统计栏与工具区，外壳不再重复一条标题行。
    hideHeader: true,
    useCollapsedSummary,
    defaultSize: 520,
    minSize: 320,
    collapsedSize: 32,
    Panel: TodoPanel,
    selection: {
      kind: KIND,
      summary: (selection) => selection.label ?? `Task ${selection.id}`,
      WorkspaceView: TodoWorkspaceView,
    },
    actions: [
      {
        id: 'copy-markdown',
        label: 'Copy as Markdown',
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
            workspace: task.workspace ?? null,
            sessionId: task.session_id ?? null,
            timeInfo: null,
          })
          await copyText(markdown)
        },
      },
    ],
  }
}
