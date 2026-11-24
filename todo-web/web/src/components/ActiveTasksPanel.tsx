import { elapsedMinutes, formatTime } from '@/lib/format'
import { cx, errorMessage } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'

interface ActiveTasksPanelProps {
  collapsed: boolean
  onCollapse: () => void
  onExpand: () => void
}

export function ActiveTasksPanel({ collapsed, onCollapse, onExpand }: ActiveTasksPanelProps) {
  const activeTasks = useTodoStore((state) => state.activeTasks)
  const activeLoading = useTodoStore((state) => state.activeLoading)
  const projects = useTodoStore((state) => state.projects)
  const selectProject = useTodoStore((state) => state.selectProject)
  const openTask = useTodoStore((state) => state.openTask)
  const selectedId = useTodoStore((state) =>
    state.detail?.mode === 'view' ? state.detail.task.id : null,
  )
  const selectedTask = useTodoStore((state) =>
    state.detail?.mode === 'view' ? state.detail.task : null,
  )

  if (collapsed) {
    const project = selectedTask
      ? projects.find((candidate) => candidate.id === selectedTask.project_id)
      : undefined
    const meta = selectedTask
      ? `${selectedTask.status}${project ? ` · ${project.name}` : ''}`
      : `${activeTasks.length} active`
    const summary = selectedTask ? `${selectedTask.title} · ${meta}` : meta

    return (
      <aside className="active-rail">
        <button
          type="button"
          className="rail-toggle"
          title="Expand activity panel"
          aria-label="Expand activity panel"
          onClick={onExpand}
        >
          «
        </button>
        <button
          type="button"
          className="active-rail-summary"
          title={summary}
          aria-label={`${summary}. Expand activity panel`}
          onClick={onExpand}
        >
          <span className="active-rail-name">{selectedTask?.title ?? 'No task'}</span>
          <span className="active-rail-meta">{meta}</span>
        </button>
      </aside>
    )
  }

  return (
    <div className="active-tasks-panel">
      <div className="active-tasks-header">
        <span className="active-tasks-title">Active</span>
        <span className="active-tasks-count">{activeTasks.length}</span>
        <button
          type="button"
          className="rail-toggle active-collapse"
          title="Collapse activity panel"
          aria-label="Collapse activity panel"
          onClick={onCollapse}
        >
          »
        </button>
      </div>
      <ul className="active-tasks-list">
        {activeLoading && activeTasks.length === 0 ? (
          <li className="active-task-item loading">Loading...</li>
        ) : null}
        {!activeLoading && activeTasks.length === 0 ? (
          <li className="active-task-item loading">No active tasks</li>
        ) : null}
        {activeTasks.map((task) => {
          const project = projects.find((candidate) => candidate.id === task.project_id)
          const blocked = task.status === 'blocked'
          const selected = task.id === selectedId
          const elapsed = elapsedMinutes(task.started_at)
          return (
            <li
              key={task.id}
              className={cx('active-task-item', blocked && 'blocked', selected && 'selected')}
              aria-current={selected ? 'true' : undefined}
              onClick={() => {
                void (async () => {
                  if (task.project_id) await selectProject(task.project_id)
                  openTask(task)
                })().catch((error) => alert(errorMessage(error)))
              }}
            >
              <span className="task-project">{project ? project.name : '-'}</span>
              <span className="task-name">{task.title}</span>
              <span className="task-time">{elapsed === null ? '-' : formatTime(elapsed)}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
