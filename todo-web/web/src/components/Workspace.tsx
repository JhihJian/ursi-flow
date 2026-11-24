import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { useEffect, useRef, useState } from 'react'
import { cx } from '@/lib/ui'
import { ActiveTasksPanel } from './ActiveTasksPanel'
import { ContentRail } from './ContentRail'
import { ProjectEditorSheet } from './ProjectEditorSheet'
import { ProjectSidebar } from './ProjectSidebar'
import { TaskDetailSheet } from './TaskDetailSheet'
import { TaskSection } from './TaskSection'

const SIDEBAR_COLLAPSED_SIZE = 32
const WORKSPACE_KEY = 'todo-web.workspace-open'

export function Workspace() {
  const layout = useDefaultLayout({ id: 'todo-web.columns' })
  const sidebarRef = usePanelRef()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(
    () => localStorage.getItem(WORKSPACE_KEY) === '1',
  )
  const lastExpandedWidth = useRef(240)

  const toggleWorkspace = (open: boolean) => {
    setWorkspaceOpen(open)
    localStorage.setItem(WORKSPACE_KEY, open ? '1' : '0')
  }

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
        <ProjectSidebar
          collapsed={sidebarCollapsed}
          onCollapse={collapseSidebar}
          onExpand={expandSidebar}
        />
      </Panel>
      <Separator className="separator" title="Drag to resize, double-click to reset" />
      <Panel
        id="content"
        className={cx('panel', 'panel-content', workspaceOpen && 'is-workspace')}
        minSize={380}
      >
        {workspaceOpen ? (
          <>
            <ContentRail onExpand={() => toggleWorkspace(false)} />
            <div className="workspace-panel" role="region" aria-label="Task execution workspace">
              <div className="workspace-placeholder">
                <span className="workspace-placeholder-title">Workspace</span>
                <span className="workspace-placeholder-text">
                  Task execution details will appear here.
                </span>
              </div>
            </div>
          </>
        ) : (
          <>
            <TaskSection onCollapse={() => toggleWorkspace(true)} />
            <ProjectEditorSheet />
            <TaskDetailSheet />
          </>
        )}
      </Panel>
      <Separator className="separator" title="Drag to resize, double-click to reset" />
      <Panel
        id="detail"
        className="panel panel-right"
        defaultSize={300}
        minSize={240}
        maxSize={480}
        groupResizeBehavior="preserve-pixel-size"
      >
        <ActiveTasksPanel />
      </Panel>
    </Group>
  )
}
