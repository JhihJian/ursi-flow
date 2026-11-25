import { useState } from 'react'
import { SidebarFrame, type ModuleSidebarProps } from '@ursi/workspace-shell'
import { ConnectionTree } from './components/ConnectionTree'
import { SshContainerProvider, useSshStore } from './ssh-context'
import { STATE_LABEL } from './terminal-state'

/** ssh 侧边栏：连接树 + 折叠条；容器 ref 供右键菜单换算坐标。 */
export function SshSidebar({ collapsed, collapse, expand }: ModuleSidebarProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const connections = useSshStore((state) => state.connections)
  const terminals = useSshStore((state) => state.terminals)
  const activeTerminalKey = useSshStore((state) => state.activeTerminalKey)
  const activeTab = terminals.find((tab) => tab.key === activeTerminalKey)
  const connection = activeTab
    ? connections.find((item) => item.id === activeTab.connectionId)
    : undefined

  const items = [
    ...(activeTab ? [{ label: '会话', value: activeTab.tmuxSession ?? 'ssh-main' }] : []),
    { label: '状态', value: STATE_LABEL[activeTab?.state ?? 'closed'] ?? '未连接' },
    ...(terminals.length > 1 ? [{ label: '标签', value: String(terminals.length) }] : []),
  ]

  return (
    <div className="ssh-embed ssh-embed-col" ref={setContainer}>
      <SshContainerProvider value={container}>
        <SidebarFrame
          title={connection?.name ?? 'SSH'}
          collapsed={collapsed}
          collapse={collapse}
          expand={expand}
          items={items}
        >
          <ConnectionTree />
        </SidebarFrame>
      </SshContainerProvider>
    </div>
  )
}
