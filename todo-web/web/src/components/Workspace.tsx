import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceFrame } from '@/hooks/useWorkspaceFrame'
import { cx } from '@/lib/ui'
import { ContentRail } from './ContentRail'
import { WorkspacePanel } from './WorkspacePanel'
import { ProjectEditorSheet } from './ProjectEditorSheet'
import { ProjectSidebar } from './ProjectSidebar'
import { TaskDetailSheet } from './TaskDetailSheet'
import { TaskSection } from './TaskSection'

const SIDEBAR_COLLAPSED_SIZE = 32
const CONTENT_COLLAPSED_SIZE = 32
const WORKSPACE_KEY = 'todo-web.workspace-open'
const FULL_PANELS = ['projects', 'content']
const RAILS_PANELS = ['projects', 'content', 'rest']

export function Workspace() {
  const { loaded: workspaceLoaded, frame } = useWorkspaceFrame()
  const sidebarRef = usePanelRef()
  const contentRef = usePanelRef()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [contentCollapsed, setContentCollapsed] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(
    () => localStorage.getItem(WORKSPACE_KEY) === '1',
  )
  const lastExpandedWidth = useRef(240)
  // 工作台没有可嵌入的页面时，内容栏只留窄条，用一块空白面板接住剩余宽度。
  const railsOnly = workspaceOpen && workspaceLoaded && !frame
  const layout = useDefaultLayout({
    id: 'todo-web.columns',
    panelIds: useMemo(() => (railsOnly ? RAILS_PANELS : FULL_PANELS), [railsOnly]),
  })

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

  // 工作台没有可嵌入的页面时，内容栏收起为 32px 窄条，间距一并去掉。
  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      const panel = contentRef.current
      if (!panel) return
      if (railsOnly) {
        if (!panel.isCollapsed()) panel.collapse()
      } else if (panel.isCollapsed()) {
        panel.expand()
      }
    })
    return () => cancelAnimationFrame(frameId)
  }, [contentRef, railsOnly])

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
        className={cx(
          'panel',
          'panel-content',
          workspaceOpen && 'is-workspace',
          contentCollapsed && 'is-collapsed',
        )}
        panelRef={contentRef}
        minSize={380}
        collapsible
        collapsedSize={CONTENT_COLLAPSED_SIZE}
        onResize={(size) => setContentCollapsed(size.inPixels <= CONTENT_COLLAPSED_SIZE + 1)}
      >
        {workspaceOpen ? (
          <>
            <ContentRail onExpand={() => toggleWorkspace(false)} />
            {frame ? <WorkspacePanel frame={frame} /> : null}
          </>
        ) : (
          <>
            <TaskSection onCollapse={() => toggleWorkspace(true)} />
            <ProjectEditorSheet />
            <TaskDetailSheet />
          </>
        )}
      </Panel>
      {railsOnly ? <Panel id="rest" /> : null}
    </Group>
  )
}
