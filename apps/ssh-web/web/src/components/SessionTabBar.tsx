import { useSshStore } from '../ssh-context'

/** 顶部标签栏：每个打开的 tmux 会话一个标签，点击激活，中键或 × 关闭；"+" 新建会话。 */
export function SessionTabBar() {
  const connections = useSshStore((state) => state.connections)
  const terminals = useSshStore((state) => state.terminals)
  const activeTerminalKey = useSshStore((state) => state.activeTerminalKey)
  const activeId = useSshStore((state) => state.activeId)
  const activateTerminal = useSshStore((state) => state.activateTerminal)
  const closeTerminal = useSshStore((state) => state.closeTerminal)
  const openSessionForm = useSshStore((state) => state.openSessionForm)

  if (terminals.length === 0) return null

  const labelOf = (connectionId: number, tmuxSession: string | null): string => {
    const session = tmuxSession ?? 'main'
    const connection = connections.find((item) => item.id === connectionId)
    return connection ? `${session} · ${connection.name}` : session
  }

  return (
    <div className="ssh-tabbar" role="tablist">
      <div className="ssh-tabbar-strip">
        {terminals.map((tab) => (
          <div
            key={tab.key}
            role="tab"
            aria-selected={tab.key === activeTerminalKey}
            title={labelOf(tab.connectionId, tab.tmuxSession)}
            className={
              tab.key === activeTerminalKey
                ? `ssh-tab active state-${tab.state}`
                : `ssh-tab state-${tab.state}`
            }
            onClick={() => activateTerminal(tab.key)}
            onAuxClick={(event) => {
              if (event.button === 1) closeTerminal(tab.key)
            }}
          >
            <span className="ssh-tab-label">{labelOf(tab.connectionId, tab.tmuxSession)}</span>
            <button
              type="button"
              className="ssh-tab-close"
              aria-label="关闭会话"
              onClick={(event) => {
                event.stopPropagation()
                closeTerminal(tab.key)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="ssh-tabbar-add"
        title="新建 tmux 会话"
        aria-label="新建 tmux 会话"
        disabled={activeId === null}
        onClick={openSessionForm}
      >
        +
      </button>
    </div>
  )
}
