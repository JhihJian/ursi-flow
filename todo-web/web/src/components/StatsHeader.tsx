import { useTodoStore } from '@/store/todo-store'
import { formatTime } from '@/lib/format'
import { cx, errorMessage } from '@/lib/ui'
import type { Period } from '@/api/types'

const periods: Array<{ period: Period; label: string }> = [
  { period: 'daily', label: 'Today' },
  { period: 'weekly', label: 'This Week' },
  { period: 'monthly', label: 'This Month' },
  { period: 'all', label: 'ALL' },
]

export function StatsHeader() {
  const projects = useTodoStore((state) => state.projects)
  const stats = useTodoStore((state) => state.stats)
  const period = useTodoStore((state) => state.period)
  const selectPeriod = useTodoStore((state) => state.selectPeriod)

  const allTasks = projects.reduce(
    (sum, project) =>
      sum +
      project.task_count.pending +
      project.task_count.in_progress +
      project.task_count.blocked +
      project.task_count.done +
      project.task_count.cancelled,
    0,
  )

  const summary = (key: 'daily' | 'weekly' | 'monthly') => {
    const stat = stats[key]
    return {
      tasks: stat ? `${stat.total_tasks} tasks` : '-',
      time: stat ? formatTime(stat.total_time_minutes) : '-',
    }
  }

  return (
    <header className="stats-header">
      <div className="stat-block">
        <span className="stat-label">Projects</span>
        <span className="stat-number">{projects.length}</span>
      </div>
      {periods.map(({ period: value, label }) => {
        const isSummary = value !== 'all'
        const data = isSummary ? summary(value) : null
        return (
          <button
            key={value}
            type="button"
            className={cx('stat-block', 'clickable', period === value && 'active')}
            aria-pressed={period === value}
            onClick={() => {
              void selectPeriod(value).catch((error) => alert(errorMessage(error)))
            }}
          >
            <span className="stat-label">{label}</span>
            <span className="stat-number">{data ? data.tasks : `${allTasks} tasks`}</span>
            {data ? <span className="stat-time">{data.time}</span> : null}
          </button>
        )
      })}
    </header>
  )
}
