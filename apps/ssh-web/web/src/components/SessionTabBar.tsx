import { useSshStore } from '../ssh-context'

/** 顶部标签栏：每个打开的 tmux 会话一个标签，点击激活，中键或 × 关闭；"+" 新建会话。 */
export function SessionTabBar() {
  const terminals = useSshStore((state) => state.terminals)
  const activeTerminalKey = useSshStore((state) => state.activeTerminalKey)
  const activeId = useSshStore((state) => state.activeId)
  const activateTerminal = useSshStore((state) => state.activateTerminal)
  const closeTerminal = useSshStore((state) => state.closeTerminal)
  const openSessionForm = useSshStore((state) => state.openSessionForm)

  const labelOf = (tmuxSession: string | null): string => tmuxSession ?? 'main'

  return (
    <div className="ssh-tabbar" role="tablist">
      <div className="ssh-tabbar-strip">
        {terminals.map((tab) => (
          <div
            key={tab.key}
            role="tab"
            aria-selected={tab.key === activeTerminalKey}
            title={labelOf(tab.tmuxSession)}
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
            <span className="ssh-tab-label">{labelOf(tab.tmuxSession)}</span>
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
        {terminals.length === 0 ? <div className="ssh-tabbar-empty">无会话</div> : null}
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
