import { SidebarFrame, type ModuleSidebarProps } from '@ursi/workspace-shell'
import { formatTime } from '@/lib/format'
import { useTodoStore } from '@/store/todo-store'
import { ProjectList } from './ProjectList'

/**
 * 外壳里的项目侧边栏：外框交给平台的 SidebarFrame，与文件、终端、沙箱一致，
 * 上下折叠，窄条上给出当前项目与未完成数量。
 */
export function TodoSidebar({ collapsed, collapse, expand }: ModuleSidebarProps) {
  const projects = useTodoStore((state) => state.projects)
  const selectedProject = useTodoStore((state) =>
    state.selectedProjectId
      ? state.projects.find((project) => project.id === state.selectedProjectId)
      : undefined,
  )
  const open = selectedProject
    ? selectedProject.task_count.pending +
      selectedProject.task_count.in_progress +
      selectedProject.task_count.blocked
    : 0

  return (
    <SidebarFrame
      title="项目"
      collapsed={collapsed}
      collapse={collapse}
      expand={expand}
      items={
        selectedProject
          ? [
              { label: '当前', value: selectedProject.name },
              { label: '未完成', value: String(open) },
              { label: '用时', value: formatTime(selectedProject.total_time_minutes) },
            ]
          : [{ label: '项目', value: String(projects.length) }]
      }
    >
      <ProjectList />
    </SidebarFrame>
  )
}
