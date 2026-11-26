import { useRef, useState } from 'react'
import { ConnectionEditorSheet } from './components/ConnectionEditorSheet'
import { NewSessionForm } from './components/NewSessionForm'
import { ResourcePanel } from './components/ResourcePanel'
import { SessionTabBar } from './components/SessionTabBar'
import { TerminalPane } from './components/TerminalPane'
import { SshContainerProvider, useSshStore } from './ssh-context'

/** 一次终端搜索请求；key 为单调递增计数，激活的 TerminalPane 只响应比上次更新的 key。 */
export interface SearchRequest {
  key: number
}

/** ssh 工作区：会话标签栏 + 终端栈 + 连接编辑浮层；不含模块标题区。 */
export function SshWorkspaceArea() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const terminals = useSshStore((state) => state.terminals)
  const activeTerminalKey = useSshStore((state) => state.activeTerminalKey)
  const sessionFormOpen = useSshStore((state) => state.sessionFormOpen)
  const resourcesOpen = useSshStore((state) => state.resourcesOpen)
  const [searchKey, setSearchKey] = useState(0)
  const seenSearchKey = useRef(0)

  const handleSearchDone = (): void => {
    seenSearchKey.current = searchKey
  }

  // 搜索快捷键挂工作区容器（capture）：只在终端区内拦截，不抢宿主的 Ctrl+F。
  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      event.stopPropagation()
      setSearchKey((key) => key + 1)
    }
  }

  return (
    <div className="ssh-embed ssh-embed-col" ref={setContainer} onKeyDownCapture={handleKeyDown}>
      <SshContainerProvider value={container}>
        <div className="ssh-main">
          <SessionTabBar />
          {sessionFormOpen ? <NewSessionForm /> : null}
          <div className="ssh-main-body">
            <div className="ssh-terminal-stack">
              {terminals.map((tab) => (
                <TerminalPane
                  key={tab.key}
                  tab={tab}
                  active={tab.key === activeTerminalKey}
                  searchKey={searchKey}
                  onSearchHandled={handleSearchDone}
                />
              ))}
              {terminals.length === 0 ? (
                <div className="ssh-terminal ssh-terminal-placeholder">
                  从左侧选择 tmux 会话，或右键新建
                </div>
              ) : null}
            </div>
            {resourcesOpen ? <ResourcePanel /> : null}
          </div>
          <ConnectionEditorSheet />
        </div>
      </SshContainerProvider>
    </div>
  )
}
