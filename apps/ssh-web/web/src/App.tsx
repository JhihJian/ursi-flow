import { useEffect, useRef, useState } from 'react'
import { Group, Panel, Separator, usePanelRef, type PanelSize } from 'react-resizable-panels'
import { SshSidebar } from './SshSidebar'
import { SshWorkspaceArea } from './SshWorkspaceArea'
import { SshModuleProvider, type SshController } from './ssh-context'

const COLLAPSED_SIZE = 32

/**
 * 独立入口：左栏连接树，右栏终端，二者与嵌入外壳用的是同一批组件。
 * controller 由 main.tsx 创建；连接列表加载由 SshModuleProvider 统一负责。
 */
export default function App({ controller }: { controller: SshController }) {
  return (
    <SshModuleProvider controller={controller}>
      <StandaloneLayout />
    </SshModuleProvider>
  )
}

function StandaloneLayout() {
  const panelRef = usePanelRef()
  const [collapsed, setCollapsed] = useState(false)
  const lastExpanded = useRef(320)

  useEffect(() => {
    if (panelRef.current?.isCollapsed()) setCollapsed(true)
  }, [panelRef])

  const onResize = (size: PanelSize) => {
    const next = size.inPixels <= COLLAPSED_SIZE + 1
    if (!next) lastExpanded.current = size.inPixels
    setCollapsed(next)
  }

  return (
    <Group orientation="horizontal" className="ssh-embed">
      <Panel
        id="ssh-side"
        className="ssh-embed-col"
        panelRef={panelRef}
        defaultSize={lastExpanded.current}
        minSize={220}
        maxSize={560}
        collapsible
        collapsedSize={COLLAPSED_SIZE}
        groupResizeBehavior="preserve-pixel-size"
        onResize={onResize}
      >
        <SshSidebar
          collapsed={collapsed}
          collapse={() => panelRef.current?.collapse()}
          expand={() => panelRef.current?.resize(lastExpanded.current)}
        />
      </Panel>
      <Separator className="ssh-standalone-separator" />
      <Panel id="ssh-main" className="ssh-embed-col" minSize={320}>
        <SshWorkspaceArea />
      </Panel>
    </Group>
  )
}
