import { useEffect } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { ConnectionEditorSheet } from './components/ConnectionEditorSheet'
import { ConnectionSidebar } from './components/ConnectionSidebar'
import { SessionSidebar } from './components/SessionSidebar'
import { TerminalPane } from './components/TerminalPane'
import { useSshStore } from './store/ssh-store'

/** 两级面板：一级连接管理，二级 tmux 会话管理，右侧终端。 */
export default function App() {
  const loadConnections = useSshStore((state) => state.loadConnections)

  useEffect(() => {
    void loadConnections().catch((error) =>
      useSshStore.getState().setNotice(error instanceof Error ? error.message : String(error)),
    )
  }, [loadConnections])

  return (
    <Group orientation="horizontal" className="workspace">
      <Panel id="connections" className="panel panel-sidebar" defaultSize={220} minSize={160} maxSize={400}>
        <ConnectionSidebar />
      </Panel>
      <Separator className="separator" title="Drag to resize" />
      <Panel id="sessions" className="panel panel-sidebar panel-sessions" defaultSize={200} minSize={140} maxSize={360}>
        <SessionSidebar />
      </Panel>
      <Separator className="separator" title="Drag to resize" />
      <Panel id="terminal" className="panel panel-content ssh-main" minSize={300}>
        <TerminalPane />
        <ConnectionEditorSheet />
      </Panel>
    </Group>
  )
}
