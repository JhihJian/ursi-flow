import { useEffect } from 'react'
import type { RailProps, WorkspaceModule, Selection } from '@ursi/workspace-shell'
import { useModuleColumn, useWorkspace } from '@ursi/workspace-shell'
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
 * 折叠态用 todo 自己的最小形态：书脊式显示当前任务与状态，
 * 点它即展开整栏，而不是笼统的「Todo」标签。
 */
function TodoRail({ onExpand, title }: RailProps) {
  const { width, resize } = useModuleColumn()
  const task = useSelectedTask()
  const tasks = useTodoStore((state) => state.tasks)
  const projects = useTodoStore((state) => state.projects)
  const project = task?.project_id
    ? projects.find((candidate) => candidate.id === task.project_id)
    : undefined

  const name = task ? task.title : title
  const meta = task
    ? `${task.status}${project ? ` · ${project.name}` : ''}`
    : `${tasks.length} tasks`

  return (
    <div className="todo-rail">
      <button
        type="button"
        className="ws-rail-toggle"
        title="展开任务栏"
        aria-label="展开任务栏"
        onClick={() => {
          // 记住展开宽度，避免每次折叠后回到默认值。
          if (width > 32) resize(width)
          onExpand()
        }}
      >
        »
      </button>
      <button
        type="button"
        className="todo-rail-summary"
        title={`${name} · ${meta}`}
        aria-label={`${name} · ${meta}。展开任务栏`}
        onClick={onExpand}
      >
        <span className="todo-rail-name">{name}</span>
        <span className="todo-rail-meta">{meta}</span>
      </button>
    </div>
  )
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
    Rail: TodoRail,
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
