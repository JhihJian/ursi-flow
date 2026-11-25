import type { ModuleSidebarProps } from '@ursi/workspace-shell'
import { ProjectSidebar } from './ProjectSidebar'

/** todo 侧边栏：项目列表，折叠态复用 ProjectSidebar 自带的书脊。 */
export function TodoSidebar({ collapsed, collapse, expand }: ModuleSidebarProps) {
  return <ProjectSidebar collapsed={collapsed} onCollapse={collapse} onExpand={expand} />
}
