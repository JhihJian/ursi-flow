import { formatTime } from '@/lib/format'
import { region } from '@demand/react'
import { useTodoStore } from '@/store/todo-store'
import { ProjectList } from './ProjectList'

interface ProjectSidebarProps {
  collapsed: boolean
  onCollapse: () => void
  onExpand: () => void
}

/**
 * 独立页面的项目栏：面板按宽度折叠，折叠后只剩一条 32px 竖栏，
 * 名称因此竖排成书脊。工作区外壳里没有这一层，那边用 SidebarFrame 上下折叠。
 */
export function ProjectSidebar({ collapsed, onCollapse, onExpand }: ProjectSidebarProps) {
  const selectedProject = useTodoStore((state) =>
    state.selectedProjectId
      ? state.projects.find((project) => project.id === state.selectedProjectId)
      : undefined,
  )

  if (collapsed) {
    const open = selectedProject
      ? selectedProject.task_count.pending +
        selectedProject.task_count.in_progress +
        selectedProject.task_count.blocked
      : 0
    const summary = selectedProject
      ? `${selectedProject.name} · ${open} tasks · ${formatTime(selectedProject.total_time_minutes)}`
      : 'No project selected'

    return (
      <aside className="sidebar sidebar-collapsed" {...region('project-list')}>
        <button
          type="button"
          className="rail-toggle"
          title="Expand projects"
          aria-label="Expand projects"
          onClick={onExpand}
        >
          »
        </button>
        <div className="collapsed-rail">
          <button
            type="button"
            className="collapsed-project"
            title={summary}
            aria-label={`${summary}. Expand projects`}
            onClick={onExpand}
          >
            <span className="collapsed-project-name">{selectedProject?.name ?? 'No project'}</span>
            {selectedProject ? (
              <span className="collapsed-project-meta">
                {' · '}
                {open} tasks · {formatTime(selectedProject.total_time_minutes)}
              </span>
            ) : null}
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="sidebar" {...region('project-list')}>
      <div className="sidebar-head">
        <h2 className="sidebar-title">Projects</h2>
        <button
          type="button"
          className="rail-toggle"
          title="Collapse projects"
          aria-label="Collapse projects"
          onClick={onCollapse}
        >
          «
        </button>
      </div>
      <ProjectList />
    </aside>
  )
}
