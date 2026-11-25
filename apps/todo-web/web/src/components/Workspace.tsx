import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { useEffect, useRef, useState } from 'react'
import { cx } from '@/lib/ui'
import { TodoSidebar } from './TodoSidebar'
import { TodoWorkspace } from './TodoWorkspace'

const SIDEBAR_COLLAPSED_SIZE = 32

export function Workspace() {
  const layout = useDefaultLayout({ id: 'todo-web.columns' })
  const sidebarRef = usePanelRef()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const lastExpandedWidth = useRef(240)

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

  useEffect(() => {
    const panel = sidebarRef.current
    if (panel) setSidebarCollapsed(panel.isCollapsed())
  }, [sidebarRef])

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
        <TodoSidebar
          collapsed={sidebarCollapsed}
          collapse={collapseSidebar}
          expand={expandSidebar}
        />
      </Panel>
      <Separator className="separator" title="Drag to resize, double-click to reset" />
      <Panel id="content" className="panel panel-content" minSize={380}>
        <TodoWorkspace />
      </Panel>
    </Group>
  )
}
