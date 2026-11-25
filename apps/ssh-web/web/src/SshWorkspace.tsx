import { useEffect, useRef, useState } from 'react'
import { ConnectionEditorSheet } from './components/ConnectionEditorSheet'
import { ConnectionSidebar } from './components/ConnectionSidebar'
import { SessionSidebar } from './components/SessionSidebar'
import { TerminalPane } from './components/TerminalPane'
import {
  SshContainerProvider,
  SshControllerProvider,
  useSshController,
  type SshController,
} from './ssh-context'

/** 一次终端搜索请求；key 为单调递增计数，TerminalPane 只响应比上次更新的 key。 */
export interface SearchRequest {
  key: number
}

/** 布局容器：180px 合并侧栏（上连接 / 下 tmux 会话）+ 终端区自适应；controller 必传。 */
export function SshWorkspace({ controller }: { controller: SshController }) {
  return (
    <SshControllerProvider controller={controller}>
      <SshShell />
    </SshControllerProvider>
  )
}

function SshShell() {
  const { store } = useSshController()
  const loadConnections = store((state) => state.loadConnections)
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [searchKey, setSearchKey] = useState(0)
  const seenSearchKey = useRef(0)

  useEffect(() => {
    void loadConnections().catch((error: unknown) =>
      store.getState().setNotice(error instanceof Error ? error.message : String(error)),
    )
  }, [loadConnections, store])

  const requestSearch = (): void => {
    setSearchKey((key) => key + 1)
  }

  const handleSearchDone = (): void => {
    seenSearchKey.current = searchKey
  }

  // 搜索快捷键挂容器（capture）：只有指针或焦点落在 ssh 模块内才拦截，不抢宿主的 Ctrl+F。
  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      event.stopPropagation()
      requestSearch()
    }
  }

  return (
    <div className="ssh-embed" ref={setContainer} onKeyDownCapture={handleKeyDown}>
      <SshContainerProvider value={container}>
        <div className="ssh-sidebar">
          <ConnectionSidebar />
          <SessionSidebar />
        </div>
        <div className="ssh-main">
          <TerminalPane searchKey={searchKey} onSearchHandled={handleSearchDone} />
          <ConnectionEditorSheet />
        </div>
      </SshContainerProvider>
    </div>
  )
}
