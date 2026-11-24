import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cx } from '@/lib/ui'
import { ContentRail } from './ContentRail'
import { ProjectEditorSheet } from './ProjectEditorSheet'
import { ProjectSidebar } from './ProjectSidebar'
import { TaskDetailSheet } from './TaskDetailSheet'
import { TaskSection } from './TaskSection'

const SIDEBAR_COLLAPSED_SIZE = 32
const CONTENT_COLLAPSED_SIZE = 32
const TASKS_COLLAPSED_KEY = 'todo-web.tasks-collapsed'
const FULL_PANELS = ['projects', 'content']
const COLLAPSED_PANELS = ['projects', 'content', 'rest']

export function Workspace() {
  const sidebarRef = usePanelRef()
  const contentRef = usePanelRef()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [contentCollapsed, setContentCollapsed] = useState(false)
  const [tasksCollapsed, setTasksCollapsed] = useState(
    () => localStorage.getItem(TASKS_COLLAPSED_KEY) === '1',
  )
  const lastExpandedWidth = useRef(240)

  // 折叠任务列表时组里多一块空白面板接住剩余宽度，否则布局无法收起内容栏。
  const layout = useDefaultLayout({
    id: 'todo-web.columns',
    panelIds: useMemo(
      () => (tasksCollapsed ? COLLAPSED_PANELS : FULL_PANELS),
      [tasksCollapsed],
    ),
  })

  const toggleTasks = (collapsed: boolean) => {
    setTasksCollapsed(collapsed)
    localStorage.setItem(TASKS_COLLAPSED_KEY, collapsed ? '1' : '0')
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

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      const panel = contentRef.current
      if (!panel) return
      if (tasksCollapsed) {
        if (!panel.isCollapsed()) panel.collapse()
      } else if (panel.isCollapsed()) {
        panel.expand()
      }
    })
    return () => cancelAnimationFrame(frameId)
  }, [contentRef, tasksCollapsed])

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
        className={cx('panel', 'panel-content', contentCollapsed && 'is-collapsed')}
        panelRef={contentRef}
        minSize={380}
        collapsible
        collapsedSize={CONTENT_COLLAPSED_SIZE}
        onResize={(size) => setContentCollapsed(size.inPixels <= CONTENT_COLLAPSED_SIZE + 1)}
      >
        {tasksCollapsed ? (
          <ContentRail onExpand={() => toggleTasks(false)} />
        ) : (
          <>
            <TaskSection onCollapse={() => toggleTasks(true)} />
            <ProjectEditorSheet />
            <TaskDetailSheet />
          </>
        )}
      </Panel>
      {tasksCollapsed ? <Panel id="rest" /> : null}
    </Group>
  )
}
