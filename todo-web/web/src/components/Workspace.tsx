import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { useEffect, useRef, useState } from 'react'
import { cx } from '@/lib/ui'
import { ContentRail } from './ContentRail'
import { ProjectEditorSheet } from './ProjectEditorSheet'
import { ProjectSidebar } from './ProjectSidebar'
import { TaskDetailSheet } from './TaskDetailSheet'
import { TaskSection } from './TaskSection'

const SIDEBAR_COLLAPSED_SIZE = 32
const CONTENT_COLLAPSED_SIZE = 32
const TASKS_COLLAPSED_KEY = 'todo-web.tasks-collapsed'

export function Workspace() {
  const layout = useDefaultLayout({ id: 'todo-web.columns' })
  const sidebarRef = usePanelRef()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [tasksCollapsed, setTasksCollapsed] = useState(
    () => localStorage.getItem(TASKS_COLLAPSED_KEY) === '1',
  )
  const lastExpandedWidth = useRef(240)

  const toggleTasks = (collapsed: boolean) => {
    setTasksCollapsed(collapsed)
    localStorage.setItem(TASKS_COLLAPSED_KEY, collapsed ? '1' : '0')
  }

  const collapseSidebar = () => {
    if (tasksCollapsed) {
      setSidebarCollapsed(true)
      return
    }
    const panel = sidebarRef.current
    if (!panel) return
    const { inPixels } = panel.getSize()
    if (inPixels > SIDEBAR_COLLAPSED_SIZE) lastExpandedWidth.current = inPixels
    panel.collapse()
  }

  const expandSidebar = () => {
    if (tasksCollapsed) {
      setSidebarCollapsed(false)
      return
    }
    sidebarRef.current?.resize(lastExpandedWidth.current)
  }

  useEffect(() => {
    const panel = sidebarRef.current
    if (panel && !tasksCollapsed) setSidebarCollapsed(panel.isCollapsed())
  }, [sidebarRef, tasksCollapsed])

  // 任务列表折叠后整体收窄到侧栏与窄条的实际宽度，按内容左对齐。
  if (tasksCollapsed) {
    return (
      <div className="workspace is-collapsed">
        <div
          className={cx('panel', 'panel-sidebar', sidebarCollapsed && 'panel-sidebar-collapsed')}
          style={{ width: sidebarCollapsed ? SIDEBAR_COLLAPSED_SIZE : sidebarWidth }}
        >
          <ProjectSidebar
            collapsed={sidebarCollapsed}
            onCollapse={collapseSidebar}
            onExpand={expandSidebar}
          />
        </div>
        <div className="separator" aria-hidden="true" />
        <div className="panel panel-content is-collapsed" style={{ width: CONTENT_COLLAPSED_SIZE }}>
          <ContentRail onExpand={() => toggleTasks(false)} />
        </div>
      </div>
    )
  }

  return (
    <Group
      orientation="horizontal"
      className="workspace"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      <Panel
        id="projects"
        className={cx('panel', 'panel-sidebar', sidebarCollapsed && 'panel-sidebar-collapsed')}
        panelRef={sidebarRef}
        defaultSize={240}
        minSize={180}
        maxSize={420}
        collapsible
        collapsedSize={SIDEBAR_COLLAPSED_SIZE}
        groupResizeBehavior="preserve-pixel-size"
        onResize={(size) => {
          const collapsed = size.inPixels <= SIDEBAR_COLLAPSED_SIZE + 1
          if (!collapsed) {
            lastExpandedWidth.current = size.inPixels
            setSidebarWidth(size.inPixels)
          }
          setSidebarCollapsed(collapsed)
        }}
      >
        <ProjectSidebar
          collapsed={sidebarCollapsed}
          onCollapse={collapseSidebar}
          onExpand={expandSidebar}
        />
      </Panel>
      <Separator className="separator" title="Drag to resize, double-click to reset" />
      <Panel id="content" className="panel panel-content" minSize={380}>
        <TaskSection onCollapse={() => toggleTasks(true)} />
        <ProjectEditorSheet />
        <TaskDetailSheet />
      </Panel>
    </Group>
  )
}
