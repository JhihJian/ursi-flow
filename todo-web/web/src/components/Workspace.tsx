import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { useEffect, useRef, useState } from 'react'
import { cx } from '@/lib/ui'
import { ActiveTasksPanel } from './ActiveTasksPanel'
import { ProjectEditorSheet } from './ProjectEditorSheet'
import { ProjectSidebar } from './ProjectSidebar'
import { TaskDetailSheet } from './TaskDetailSheet'
import { TaskSection } from './TaskSection'

const SIDEBAR_COLLAPSED_SIZE = 32
const DETAIL_COLLAPSED_SIZE = 32

export function Workspace() {
  const layout = useDefaultLayout({ id: 'todo-web.columns' })
  const sidebarRef = usePanelRef()
  const detailRef = usePanelRef()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [detailCollapsed, setDetailCollapsed] = useState(false)
  const lastExpandedWidth = useRef(240)
  const lastDetailWidth = useRef(320)

  const collapseSidebar = () => {
    const panel = sidebarRef.current
    if (!panel) return
    const { inPixels } = panel.getSize()
    if (inPixels > SIDEBAR_COLLAPSED_SIZE) lastExpandedWidth.current = inPixels
    panel.collapse()
  }

  const expandSidebar = () => {
    sidebarRef.current?.resize(lastExpandedWidth.current)
  }

  const collapseDetail = () => {
    const panel = detailRef.current
    if (!panel) return
    const { inPixels } = panel.getSize()
    if (inPixels > DETAIL_COLLAPSED_SIZE) lastDetailWidth.current = inPixels
    panel.collapse()
  }

  const expandDetail = () => {
    detailRef.current?.resize(lastDetailWidth.current)
  }

  useEffect(() => {
    const sidebar = sidebarRef.current
    if (sidebar) setSidebarCollapsed(sidebar.isCollapsed())
    const detail = detailRef.current
    if (detail) setDetailCollapsed(detail.isCollapsed())
  }, [sidebarRef, detailRef])

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
          if (!collapsed) lastExpandedWidth.current = size.inPixels
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
        <TaskSection />
        <ProjectEditorSheet />
        <TaskDetailSheet />
      </Panel>
      <Separator className="separator" title="Drag to resize, double-click to reset" />
      <Panel
        id="detail"
        className={cx('panel', 'panel-right', detailCollapsed && 'panel-right-collapsed')}
        panelRef={detailRef}
        defaultSize={300}
        minSize={200}
        maxSize={480}
        collapsible
        collapsedSize={DETAIL_COLLAPSED_SIZE}
        groupResizeBehavior="preserve-pixel-size"
        onResize={(size) => {
          const collapsed = size.inPixels <= DETAIL_COLLAPSED_SIZE + 1
          if (!collapsed) lastDetailWidth.current = size.inPixels
          setDetailCollapsed(collapsed)
        }}
      >
        <ActiveTasksPanel
          collapsed={detailCollapsed}
          onCollapse={collapseDetail}
          onExpand={expandDetail}
        />
      </Panel>
    </Group>
  )
}
