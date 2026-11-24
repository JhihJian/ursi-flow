import { elapsedMinutes, formatTime } from '@/lib/format'
import { cx, errorMessage } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'

export function ActiveTasksPanel() {
  const activeTasks = useTodoStore((state) => state.activeTasks)
  const activeLoading = useTodoStore((state) => state.activeLoading)
  const projects = useTodoStore((state) => state.projects)
  const selectProject = useTodoStore((state) => state.selectProject)
  const openTask = useTodoStore((state) => state.openTask)

  return (
    <div className="active-tasks-panel">
      <div className="active-tasks-header">
        <span className="active-tasks-title">Active</span>
        <span className="active-tasks-count">{activeTasks.length}</span>
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
          const elapsed = elapsedMinutes(task.started_at)
          return (
            <li
              key={task.id}
              className={cx('active-task-item', blocked && 'blocked')}
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
