import { useState, type MouseEvent } from 'react'
import { ContextMenu, type MenuState } from './ContextMenu'
import { useSshStore } from '../store/ssh-store'

/** tmux 会话名：字母数字下划线连字符，1-64 字符，与服务端白名单一致。 */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 二级侧栏：当前连接的 tmux 会话管理。列出、attach、新建；改名与删除在终端里用 tmux 命令完成。 */
export function SessionSidebar() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const activeId = useSshStore((state) => state.activeId)
  const connections = useSshStore((state) => state.connections)
  const tmuxSessions = useSshStore((state) => state.tmuxSessions)
  const tmuxLoading = useSshStore((state) => state.tmuxLoading)
  const terminal = useSshStore((state) => state.terminal)
  const notice = useSshStore((state) => state.notice)
  const openTerminal = useSshStore((state) => state.openTerminal)
  const refreshTmuxSessions = useSshStore((state) => state.refreshTmuxSessions)

  const connection = connections.find((item) => item.id === activeId)
  const isAttached = (sessionName: string) =>
    terminal !== null &&
    terminal.connectionId === activeId &&
    (terminal.tmuxSession ?? 'ssh-main') === sessionName

  const openContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    const items: MenuState['items'] = [{ label: 'New session', onSelect: () => setCreating(true) }]
    if (activeId !== null) items.push({ label: 'Refresh', onSelect: () => void refreshTmuxSessions() })
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  const submitNew = () => {
    const trimmed = name.trim()
    if (!NAME_PATTERN.test(trimmed)) {
      useSshStore.getState().setNotice('会话名仅限字母、数字、下划线、连字符，最长 64 字符。')
      return
    }
    setCreating(false)
    setName('')
    openTerminal(trimmed)
  }

  if (activeId === null || !connection) {
    return (
      <div className="sidebar" onContextMenu={openContextMenu}>
        <div className="sidebar-head">
          <div className="sidebar-title">Sessions</div>
        </div>
        <div className="empty-state">选择左侧连接</div>
        <ContextMenu state={menu} onClose={() => setMenu(null)} />
      </div>
    )
  }

  return (
    <div className="sidebar" onContextMenu={openContextMenu}>
      <div className="sidebar-head">
        <div className="sidebar-title">{connection.name}</div>
        <button
          type="button"
          className="rail-toggle"
          title="刷新 tmux 会话列表"
          aria-label="刷新 tmux 会话列表"
          onClick={() => void refreshTmuxSessions()}
        >
          ↻
        </button>
      </div>
      {tmuxLoading ? <div className="empty-state">查询中…</div> : null}
      {!tmuxLoading && tmuxSessions === null ? (
        <div className={notice ? 'session-note session-error' : 'session-note'}>
          {notice ?? '远端无 tmux，连接后将回退普通 shell，断开即结束。'}
        </div>
      ) : null}
      {!tmuxLoading && tmuxSessions !== null ? (
        <ul className="connection-list">
          <li
            className={
              terminal && terminal.tmuxSession === null && terminal.connectionId === activeId
                ? 'connection-item active'
                : 'connection-item'
            }
            onClick={() => openTerminal(null)}
          >
            <span className="name">main</span>
            <span className="meta">默认会话 ssh-main</span>
          </li>
          {tmuxSessions.map((session) => (
            <li
              key={session.name}
              className={isAttached(session.name) ? 'connection-item active' : 'connection-item'}
              onClick={() => openTerminal(session.name)}
              title={`${session.attached} client${session.attached === 1 ? '' : 's'} attached`}
            >
              <span className="name">
                {session.name}
                {session.attached > 0 ? ' ●' : ''}
              </span>
              <span className="meta">{new Date(session.created * 1000).toLocaleString()}</span>
            </li>
          ))}
          {tmuxSessions.length === 0 ? (
            <li className="empty-state">远端暂无 tmux 会话</li>
          ) : null}
        </ul>
      ) : null}
      {creating ? (
        <div className="session-new">
          <input
            className="form-input"
            autoFocus
            placeholder="新会话名"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitNew()
              if (event.key === 'Escape') {
                setCreating(false)
                setName('')
              }
            }}
          />
          <div className="session-new-actions">
            <button type="button" className="btn btn-primary" onClick={submitNew}>
              打开
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setCreating(false)
                setName('')
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
