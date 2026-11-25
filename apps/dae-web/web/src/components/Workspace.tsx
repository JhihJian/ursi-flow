import { useEffect, useRef, useState } from 'react'
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { ConfigSection } from './ConfigSection'
import { ConnectionsSection } from './ConnectionsSection'
import { DetailSheet } from './DetailSheet'
import { DnsSection } from './DnsSection'
import { FlowsSection } from './FlowsSection'
import { LogsSection } from './LogsSection'
import { OverviewSection } from './OverviewSection'
import { RulesSection } from './RulesSection'
import { SectionHeader } from './SectionHeader'
import { Sidebar } from './Sidebar'
import { cx } from '@/lib/ui'
import { useDaeStore } from '@/store/dae-store'

const SIDEBAR_COLLAPSED_SIZE = 32

function SectionBody() {
  const section = useDaeStore((state) => state.section)
  switch (section) {
    case 'overview':
      return <OverviewSection />
    case 'connections':
      return <ConnectionsSection />
    case 'flows':
      return <FlowsSection />
    case 'rules':
      return <RulesSection />
    case 'dns':
      return <DnsSection />
    case 'logs':
      return <LogsSection />
    case 'config':
      return <ConfigSection />
  }
}

export function Workspace() {
  const layout = useDefaultLayout({ id: 'dae-web.columns' })
  const sidebarRef = usePanelRef()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const lastExpandedWidth = useRef(200)
  const selected = useDaeStore((state) => state.selected)

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
        id="nav"
        className={cx('panel', 'panel-sidebar', sidebarCollapsed && 'panel-sidebar-collapsed')}
        panelRef={sidebarRef}
        defaultSize={200}
        minSize={168}
        maxSize={320}
        collapsible
        collapsedSize={SIDEBAR_COLLAPSED_SIZE}
        groupResizeBehavior="preserve-pixel-size"
        onResize={(size) => {
          const collapsed = size.inPixels <= SIDEBAR_COLLAPSED_SIZE + 1
          if (!collapsed) lastExpandedWidth.current = size.inPixels
          setSidebarCollapsed(collapsed)
        }}
      >
        <Sidebar
          collapsed={sidebarCollapsed}
          onCollapse={collapseSidebar}
          onExpand={expandSidebar}
        />
      </Panel>
      <Separator className="separator" title="拖动调整宽度，双击复位" />
      <Panel id="content" className="panel panel-content" minSize={420}>
        <SectionHeader />
        <div className="section-body">
          <SectionBody />
        </div>
        {selected ? <DetailSheet /> : null}
      </Panel>
    </Group>
  )
}
