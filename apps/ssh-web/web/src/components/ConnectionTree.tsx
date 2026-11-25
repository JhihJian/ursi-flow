import { useState, type MouseEvent } from 'react'
import { ContextMenu, type MenuState } from './ContextMenu'
import { useSshContainer, useSshController, useSshStore } from '../ssh-context'
import type { Connection } from '../api/types'
import type { SessionsState } from '../store/ssh-store'

/** 一级侧栏树：连接为父节点，默认全部展开并各自加载 tmux 会话子级；点会话即在标签栏打开。 */
export function ConnectionTree() {
  const container = useSshContainer()
  const { store } = useSshController()
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** 用户手动收起的连接集合：默认全部展开，只有点 chevron 才收起。 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set())
  /** 删除确认：记住待删连接，在侧栏底部内联确认，不用 window.prompt。 */
  const [pendingDelete, setPendingDelete] = useState<Connection | null>(null)
  const [confirmName, setConfirmName] = useState('')
  const connections = useSshStore((state) => state.connections)
  const activeId = useSshStore((state) => state.activeId)
  const notice = useSshStore((state) => state.notice)
  const sessionsByConnection = useSshStore((state) => state.sessionsByConnection)
  const terminals = useSshStore((state) => state.terminals)
  const selectConnection = useSshStore((state) => state.selectConnection)
  const openTerminal = useSshStore((state) => state.openTerminal)
  const openSessionForm = useSshStore((state) => state.openSessionForm)
  const setEditor = useSshStore((state) => state.setEditor)
  const removeConnection = useSshStore((state) => state.removeConnection)
  const refreshTmuxSessions = useSshStore((state) => state.refreshTmuxSessions)

  const toMenuState = (event: MouseEvent, items: MenuState['items']): MenuState | null => {
    if (!container) return null
    const rect = container.getBoundingClientRect()
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      items,
    }
  }

  const openContextMenu = (event: MouseEvent, connection: Connection | null) => {
    event.preventDefault()
    const items: MenuState['items'] = [
      { label: 'New connection', onSelect: () => setEditor({ kind: 'new' }) },
    ]
    if (connection) {
      items.push(
        { label: 'New session', onSelect: () => void selectConnection(connection.id).then(openSessionForm) },
        { label: 'Edit', onSelect: () => setEditor({ kind: 'edit', connection }) },
        {
          label: 'Delete',
          danger: true,
          onSelect: () => {
            setPendingDelete(connection)
            setConfirmName('')
          },
        },
      )
    }
    setMenu(toMenuState(event, items))
  }

  const toggleCollapse = (id: number): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectConnectionRow = (id: number): void => {
    setCollapsed((current) => {
      if (!current.has(id)) return current
      const next = new Set(current)
      next.delete(id)
      return next
    })
    void selectConnection(id)
  }

  const isOpen = (connectionId: number, tmuxSession: string | null): boolean =>
    terminals.some(
      (tab) =>
        tab.connectionId === connectionId &&
        (tab.tmuxSession ?? 'main') === (tmuxSession ?? 'main'),
    )

  const submitDelete = () => {
    if (!pendingDelete) return
    if (confirmName !== pendingDelete.name) {
      store.getState().setNotice('名称不匹配，未删除。')
      return
    }
    setPendingDelete(null)
    setConfirmName('')
    removeConnection(pendingDelete.id).catch((error: unknown) => {
      store.getState().setNotice(error instanceof Error ? error.message : String(error))
    })
  }

  const renderSessionChildren = (connectionId: number, state: SessionsState | undefined) => {
    if (!state || state.loading) return <li className="ssh-tree-note">查询中…</li>
    if (state.error !== null) {
      return <li className="ssh-tree-note ssh-error-note">{state.error}</li>
    }
    if (state.sessions === null) {
      return <li className="ssh-tree-note">远端无 tmux，连接后将回退普通 shell，断开即结束。</li>
    }
    return (
      <>
        <SessionChildRow
          rowKey="::default"
          label="main"
          meta="默认会话 ssh-main"
          open={isOpen(connectionId, null)}
          onClick={() => openTerminal(connectionId, null)}
        />
        {state.sessions.map((session) => (
          <SessionChildRow
            key={session.name}
            rowKey={session.name}
            label={session.name}
            meta={new Date(session.created * 1000).toLocaleString()}
            attached={session.attached}
            open={isOpen(connectionId, session.name)}
            onClick={() => openTerminal(connectionId, session.name)}
          />
        ))}
        {state.sessions.length === 0 ? <li className="ssh-tree-note">远端暂无 tmux 会话</li> : null}
      </>
    )
  }

  return (
    <div className="ssh-tree" onContextMenu={(event) => openContextMenu(event, null)}>
      <div className="ssh-sidebar-head">
        <div className="ssh-sidebar-title">SSH</div>
        <button
          type="button"
          className="ssh-mini-btn"
          title="刷新会话列表"
          aria-label="刷新会话列表"
          onClick={() => {
            connections.forEach((connection) => void refreshTmuxSessions(connection.id))
          }}
        >
          ↻
        </button>
        <button
          type="button"
          className="ssh-mini-btn"
          aria-label="新建连接"
          onClick={() => setEditor({ kind: 'new' })}
        >
          +
        </button>
      </div>
      <ul className="ssh-item-list">
        {connections.map((connection) => {
          const expanded = !collapsed.has(connection.id)
          const selected = connection.id === activeId
          return (
            <li key={connection.id} className="ssh-tree-node">
              <div
                className={selected ? 'ssh-tree-row parent active' : 'ssh-tree-row parent'}
                onClick={() => selectConnectionRow(connection.id)}
                onContextMenu={(event) => openContextMenu(event, connection)}
                title={connection.command}
              >
                <button
                  type="button"
                  className={expanded ? 'ssh-tree-chevron open' : 'ssh-tree-chevron'}
                  aria-label={expanded ? '收起' : '展开'}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleCollapse(connection.id)
                  }}
                >
                  ▸
                </button>
                <span className="ssh-tree-label">{connection.name}</span>
              </div>
              {expanded ? (
                <ul className="ssh-tree-children">
                  {renderSessionChildren(connection.id, sessionsByConnection[connection.id])}
                </ul>
              ) : null}
            </li>
          )
        })}
        {connections.length === 0 ? <li className="ssh-empty">右键新建连接</li> : null}
      </ul>
      {notice && !pendingDelete ? <div className="ssh-tree-note ssh-error-note">{notice}</div> : null}
      {pendingDelete ? (
        <div className="ssh-confirm">
          <div className="ssh-confirm-text">
            输入 <b>{pendingDelete.name}</b> 确认删除：
          </div>
          <input
            className="ssh-input"
            autoFocus
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitDelete()
              if (event.key === 'Escape') {
                setPendingDelete(null)
                setConfirmName('')
              }
            }}
          />
          <div className="ssh-confirm-actions">
            <button type="button" className="ssh-btn ssh-btn-danger" onClick={submitDelete}>
              删除
            </button>
            <button
              type="button"
              className="ssh-btn"
              onClick={() => {
                setPendingDelete(null)
                setConfirmName('')
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

/** 会话子行：label 与标签栏内容一致；attached > 0 时在 meta 标 ●（远端有客户端）。 */
function SessionChildRow({
  rowKey,
  label,
  meta,
  attached,
  open,
  onClick,
}: {
  rowKey: string
  label: string
  meta: string
  attached?: number
  open: boolean
  onClick: () => void
}) {
  const attachedNote =
    attached !== undefined && attached > 0
      ? `${attached} client${attached === 1 ? '' : 's'} attached`
      : undefined
  return (
    <li
      key={rowKey}
      className={open ? 'ssh-tree-row child active' : 'ssh-tree-row child'}
      onClick={onClick}
      title={attachedNote}
    >
      <span className="ssh-tree-label">
        {label}
        {open ? ' ●' : ''}
      </span>
      <span className="ssh-tree-meta">{meta}</span>
    </li>
  )
}
