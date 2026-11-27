import { useCallback, useRef, useState } from 'react'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import type { ProjectStats } from '@/api/types'
import { formatTime } from '@/lib/format'
import { cx, errorMessage, readTaskDrag } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'
import { ContextMenu, type MenuItem, type MenuState } from '@ursi/sidebar'

function projectTooltip(project: ProjectStats): string {
  return [project.name, project.description, project.path].filter(Boolean).join(' · ')
}

type OpenMenu = (clientX: number, clientY: number, items: MenuItem[], heading?: string) => void

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
    { label: 'new project', onSelect: startCreateProject },
    { label: 'edit project', onSelect: () => startEditProject(project.id) },
    {
      label: 'delete project',
      danger: true,
      onSelect: () => {
        const confirmItems: MenuItem[] = [
          {
            label: 'delete project',
            danger: true,
            onSelect: () => {
              void removeProject(project.id).catch((error) =>
                alert(`Failed to delete project: ${errorMessage(error)}`),
              )
            },
          },
          { label: 'cancel', onSelect: () => {} },
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
        'sb-row',
        'project-item',
        active && 'is-active',
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

/** 项目列表本体：分成「列表内容」和「外框」两件事，外壳与独立页面各自提供外框。 */
export function ProjectList() {
  const projects = useTodoStore((state) => state.projects)
  const projectsLoading = useTodoStore((state) => state.projectsLoading)
  const projectsError = useTodoStore((state) => state.projectsError)
  const selectedProjectId = useTodoStore((state) => state.selectedProjectId)
  const startCreateProject = useTodoStore((state) => state.startCreateProject)
  // 外层不滚动，只作菜单容器；列表在内层滚动，菜单才不会被裁或随滚动跑位。
  const menuContainer = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const openMenu = useCallback<OpenMenu>((clientX, clientY, items, heading) => {
    const host = menuContainer.current
    if (!host) return
    const rect = host.getBoundingClientRect()
    setMenu({ x: clientX - rect.left, y: clientY - rect.top, items, heading })
  }, [])
  const closeMenu = useCallback(() => setMenu(null), [])

  return (
    <div className="project-list-frame" ref={menuContainer}>
      <div
        className="project-list-body"
        onContextMenu={(event) => {
          // 项目项自己处理右键；落在空白处时提示新建项目。
          event.preventDefault()
          openMenu(event.clientX, event.clientY, [{ label: 'new project', onSelect: startCreateProject }])
        }}
      >
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
                  openMenu={openMenu}
                />
              ))
            : null}
        </ul>
      </div>
      <ContextMenu state={menu} onClose={closeMenu} container={menuContainer.current} />
    </div>
  )
}
