import { statusSymbol } from '@/lib/format'
import { useTodoStore } from '@/store/todo-store'

/**
 * 任务列表折叠后的窄条：书脊式显示当前任务的标题与关键状态，
 * 点击或按 `»` 回到任务列表。
 */
export function ContentRail({ onExpand }: { onExpand: () => void }) {
  const selectedTask = useTodoStore((state) =>
    state.detail?.mode === 'view' ? state.detail.task : null,
  )
  const tasks = useTodoStore((state) => state.tasks)
  const projects = useTodoStore((state) => state.projects)
  const project = selectedTask
    ? projects.find((candidate) => candidate.id === selectedTask.project_id)
    : undefined

  const name = selectedTask ? selectedTask.title : 'Tasks'
  const meta = selectedTask
    ? `${statusSymbol(selectedTask.status)} ${selectedTask.status}${project ? ` · ${project.name}` : ''}`
    : `${tasks.length} tasks`

  return (
    <aside className="content-rail">
      <button
        type="button"
        className="rail-toggle"
        title="Back to tasks"
        aria-label="Back to tasks"
        onClick={onExpand}
      >
        »
      </button>
      <button
        type="button"
        className="content-rail-summary"
        title={`${name} · ${meta}`}
        aria-label={`${name} · ${meta}. Back to tasks`}
        onClick={onExpand}
      >
        <span className="content-rail-name">{name}</span>
        <span className="content-rail-meta">{meta}</span>
      </button>
    </aside>
  )
}
