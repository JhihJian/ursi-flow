import { useEffect } from 'react'
import { ConnectionEditorSheet } from './components/ConnectionEditorSheet'
import { ConnectionSidebar } from './components/ConnectionSidebar'
import { SessionSidebar } from './components/SessionSidebar'
import { TerminalPane } from './components/TerminalPane'
import { useSshController, useSshStore } from './ssh-context'

/**
 * 独立入口：与工作区嵌入共用同一套组件与布局（合并侧栏 + 终端），
 * controller 由 main.tsx 创建并经 Provider 注入，这里只负责首屏加载连接列表。
 */
export default function App() {
  const { store } = useSshController()
  const loadConnections = useSshStore((state) => state.loadConnections)

  useEffect(() => {
    void loadConnections().catch((error: unknown) =>
      store.getState().setNotice(error instanceof Error ? error.message : String(error)),
    )
  }, [loadConnections, store])

  return (
    <div className="ssh-embed ssh-standalone">
      <div className="ssh-sidebar">
        <ConnectionSidebar />
        <SessionSidebar />
      </div>
      <div className="ssh-main">
        <TerminalPane searchKey={0} onSearchHandled={() => {}} />
        <ConnectionEditorSheet />
      </div>
    </div>
  )
}
