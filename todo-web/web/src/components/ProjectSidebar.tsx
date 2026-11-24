import { useDndContext, useDroppable } from '@dnd-kit/core'
import type { ProjectStats } from '@/api/types'
import { formatTime } from '@/lib/format'
import { cx, errorMessage, readTaskDrag } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'

function ProjectItem({ project, active }: { project: ProjectStats; active: boolean }) {
  const selectProject = useTodoStore((state) => state.selectProject)
  const { active: drag } = useDndContext()
  const dragging = readTaskDrag(drag?.data.current) !== null
  const { setNodeRef, isOver } = useDroppable({
    id: `project-${project.id}`,
    data: { type: 'project', projectId: project.id },
  })
  const open = project.task_count.pending + project.task_count.in_progress + project.task_count.blocked

  return (
    <li
      ref={setNodeRef}
      className={cx(
        'project-item',
        active && 'active',
        dragging && 'drop-ready',
        isOver && 'drop-over',
      )}
      onClick={() => {
        void selectProject(project.id).catch((error) => alert(errorMessage(error)))
      }}
    >
      <span className="name">{project.name}</span>
      <span className="meta">
        {open} tasks / {formatTime(project.total_time_minutes)}
      </span>
    </li>
  )
}

interface ProjectSidebarProps {
  collapsed: boolean
  onCollapse: () => void
  onExpand: () => void
}

export function ProjectSidebar({ collapsed, onCollapse, onExpand }: ProjectSidebarProps) {
  const projects = useTodoStore((state) => state.projects)
  const projectsLoading = useTodoStore((state) => state.projectsLoading)
  const projectsError = useTodoStore((state) => state.projectsError)
  const selectedProjectId = useTodoStore((state) => state.selectedProjectId)
  const startCreateProject = useTodoStore((state) => state.startCreateProject)
  const selectedProject = useTodoStore((state) =>
    state.selectedProjectId
      ? state.projects.find((project) => project.id === state.selectedProjectId)
      : undefined,
  )

  if (collapsed) {
    const active = selectedProject
      ? selectedProject.task_count.pending +
        selectedProject.task_count.in_progress +
        selectedProject.task_count.blocked
      : 0
    const summary = selectedProject
      ? `${selectedProject.name} · ${active} tasks · ${formatTime(selectedProject.total_time_minutes)}`
      : 'No project selected'

    return (
      <aside className="sidebar sidebar-collapsed">
        <button
          type="button"
          className="sidebar-expand"
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
                {active} tasks · {formatTime(selectedProject.total_time_minutes)}
              </span>
            ) : null}
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="action-bar">
        <h2 className="sidebar-title">Projects</h2>
        <div className="sidebar-actions">
          <button
            type="button"
            className="sidebar-collapse"
            title="Collapse projects"
            aria-label="Collapse projects"
            onClick={onCollapse}
          >
            «
          </button>
          <button type="button" className="btn btn-sm" onClick={startCreateProject}>
            + Project
          </button>
        </div>
      </div>
      <ul className="project-list">
        {projectsLoading ? <li className="project-item loading">Loading...</li> : null}
        {!projectsLoading && projectsError ? (
          <li className="project-item loading">Error loading projects</li>
        ) : null}
        {!projectsLoading && !projectsError && projects.length === 0 ? (
          <li className="project-item loading">No projects</li>
        ) : null}
        {!projectsLoading
          ? projects.map((project) => (
              <ProjectItem
                key={project.id}
                project={project}
                active={project.id === selectedProjectId}
              />
            ))
          : null}
      </ul>
    </aside>
  )
}
