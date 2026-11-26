import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { useEffect, useRef, useState } from 'react'
import type { Listing, SessionRow } from '@/api'
import { cx } from '@/lib/ui'
import { SessionSidebar } from './SessionSidebar'
import { SessionWorkspace } from './SessionWorkspace'

const SIDEBAR_COLLAPSED_SIZE = 32

interface WorkspaceProps {
  root: string
  listing: Listing | null
  loading: boolean
  error: string | null
  query: string
  onQueryChange: (query: string) => void
  selectedRow: SessionRow | null
  onSelect: (row: SessionRow) => void
  onReload: () => void
  onRootChange: (root: string) => void
  defaultRoot: string
  suggestedRoots: string[]
  pinnedProjects: string[]
  onTogglePin: (projectKey: string, pinned: boolean) => void
  onDeleteSession: (row: SessionRow) => void
}

/** 两栏骨架：左侧会话分组，右侧轨迹。分隔条拖动、双击复位，与看板一致。 */
export function Workspace({
  root,
  listing,
  loading,
  error,
  query,
  onQueryChange,
  selectedRow,
  onSelect,
  onReload,
  onRootChange,
  defaultRoot,
  suggestedRoots,
  pinnedProjects,
  onTogglePin,
  onDeleteSession,
}: WorkspaceProps) {
  const layout = useDefaultLayout({ id: 'pi-sessions-web.columns' })
  const sidebarRef = usePanelRef()
  const [collapsed, setCollapsed] = useState(false)
  const lastExpandedWidth = useRef(260)

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
    if (panel) setCollapsed(panel.isCollapsed())
  }, [sidebarRef])

  return (
    <Group
      orientation="horizontal"
      className="workspace"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      <Panel
        id="sessions"
        className={cx('panel', 'panel-sidebar', collapsed && 'panel-sidebar-collapsed')}
        panelRef={sidebarRef}
        defaultSize={260}
        minSize={200}
        maxSize={460}
        collapsible
        collapsedSize={SIDEBAR_COLLAPSED_SIZE}
        groupResizeBehavior="preserve-pixel-size"
        onResize={(size) => {
          const isCollapsed = size.inPixels <= SIDEBAR_COLLAPSED_SIZE + 1
          if (!isCollapsed) lastExpandedWidth.current = size.inPixels
          setCollapsed(isCollapsed)
        }}
      >
        <SessionSidebar
          root={root}
          listing={listing}
          loading={loading}
          error={error}
          query={query}
          onQueryChange={onQueryChange}
          selectedId={selectedRow?.id ?? null}
          selectedRow={selectedRow}
          onSelect={onSelect}
          onReload={onReload}
          onRootChange={onRootChange}
          defaultRoot={defaultRoot}
          suggestedRoots={suggestedRoots}
          pinnedProjects={pinnedProjects}
          onTogglePin={onTogglePin}
          onDeleteSession={onDeleteSession}
          collapsed={collapsed}
          onCollapse={collapseSidebar}
          onExpand={expandSidebar}
        />
      </Panel>
      <Separator className="separator" title="拖动调整宽度，双击复位" />
      <Panel id="session" className="panel panel-content" minSize={420}>
        <SessionWorkspace root={root} row={selectedRow} />
      </Panel>
    </Group>
  )
}
