import { useDroppable } from '@dnd-kit/core'
import type { ProjectStats } from '@/api/types'
import { formatTime } from '@/lib/format'
import { cx, errorMessage } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'

function ProjectItem({ project, active }: { project: ProjectStats; active: boolean }) {
  const selectProject = useTodoStore((state) => state.selectProject)
  const { setNodeRef, isOver } = useDroppable({
    id: `project-${project.id}`,
    data: { type: 'project', projectId: project.id },
  })
  const open = project.task_count.pending + project.task_count.in_progress + project.task_count.blocked

  return (
    <li
      ref={setNodeRef}
      className={cx('project-item', active && 'active', isOver && 'drop-over')}
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

export function ProjectSidebar() {
  const projects = useTodoStore((state) => state.projects)
  const projectsLoading = useTodoStore((state) => state.projectsLoading)
  const projectsError = useTodoStore((state) => state.projectsError)
  const selectedProjectId = useTodoStore((state) => state.selectedProjectId)
  const startCreateProject = useTodoStore((state) => state.startCreateProject)

  return (
    <aside className="sidebar">
      <div className="action-bar">
        <h2 className="sidebar-title">Projects</h2>
        <button type="button" className="btn btn-sm" onClick={startCreateProject}>
          + Project
        </button>
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
