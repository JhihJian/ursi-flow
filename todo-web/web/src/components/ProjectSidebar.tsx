import { useState } from 'react'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import type { ProjectStats } from '@/api/types'
import { formatTime } from '@/lib/format'
import { cx, errorMessage, readTaskDrag } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu'

function projectTooltip(project: ProjectStats): string {
  return [project.name, project.description, project.path].filter(Boolean).join(' · ')
}

type OpenMenu = (x: number, y: number, items: MenuItem[], heading?: string) => void

function ProjectItem({
  project,
  active,
  openMenu,
}: {
  project: ProjectStats
  active: boolean
  openMenu: OpenMenu
}) {
  const selectProject = useTodoStore((state) => state.selectProject)
  const openNewTask = useTodoStore((state) => state.openNewTask)
  const startEditProject = useTodoStore((state) => state.startEditProject)
  const startCreateProject = useTodoStore((state) => state.startCreateProject)
  const removeProject = useTodoStore((state) => state.removeProject)
  const { active: drag } = useDndContext()
  const dragging = readTaskDrag(drag?.data.current) !== null
  const { setNodeRef, isOver } = useDroppable({
    id: `project-${project.id}`,
    data: { type: 'project', projectId: project.id },
  })
  const open = project.task_count.pending + project.task_count.in_progress + project.task_count.blocked

  const menuItems: MenuItem[] = [
    {
      label: 'New task',
      onSelect: () => {
        void selectProject(project.id)
          .then(() => openNewTask())
          .catch((error) => alert(errorMessage(error)))
      },
    },
    { label: 'New project', onSelect: startCreateProject },
    { label: 'Edit project', onSelect: () => startEditProject(project.id) },
    {
      label: 'Delete project',
      danger: true,
      onSelect: () => {
        const confirmItems: MenuItem[] = [
          {
            label: 'Delete project',
            danger: true,
            onSelect: () => {
              void removeProject(project.id).catch((error) =>
                alert(`Failed to delete project: ${errorMessage(error)}`),
              )
            },
          },
          { label: 'Cancel', onSelect: () => {} },
        ]
        // 菜单已关闭，再在项目项位置弹出确认菜单。
        const rect = document
          .querySelector(`[data-project-id="${project.id}"]`)
          ?.getBoundingClientRect()
        openMenu(rect?.left ?? 0, (rect?.bottom ?? 0) + 4, confirmItems, `Delete "${project.name}"?`)
      },
    },
  ]

  return (
    <li
      ref={setNodeRef}
      data-project-id={project.id}
      className={cx(
        'project-item',
        active && 'active',
        dragging && 'drop-ready',
        isOver && 'drop-over',
      )}
      title={projectTooltip(project)}
      onClick={() => {
        void selectProject(project.id).catch((error) => alert(errorMessage(error)))
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openMenu(event.clientX, event.clientY, menuItems)
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
  const [menu, setMenu] = useState<MenuState | null>(null)

  const showMenu: OpenMenu = (x, y, items, heading) => setMenu({ x, y, items, heading })

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
    <aside
      className="sidebar"
      onContextMenu={(event) => {
        // 项目项自己处理右键；落在空白处时提示新建项目。
        event.preventDefault()
        showMenu(event.clientX, event.clientY, [
          { label: 'New project', onSelect: startCreateProject },
        ])
      }}
    >
      <div className="sidebar-head">
        <h2 className="sidebar-title">Projects</h2>
        <button
          type="button"
          className="sidebar-collapse"
          title="Collapse projects"
          aria-label="Collapse projects"
          onClick={onCollapse}
        >
          «
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
                openMenu={showMenu}
              />
            ))
          : null}
      </ul>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </aside>
  )
}
