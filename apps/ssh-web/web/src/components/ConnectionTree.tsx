import { useState, type MouseEvent } from 'react'
import { ContextMenu, type MenuState } from './ContextMenu'
import { useSshContainer, useSshController, useSshStore } from '../ssh-context'
import type { Connection } from '../api/types'

/** 一级侧栏树：连接为父节点，选中的连接展开 tmux 会话子级；点会话即在标签栏打开。 */
export function ConnectionTree() {
  const container = useSshContainer()
  const { store } = useSshController()
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** 展开的连接集合：点击连接名即选中并展开。 */
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  /** 删除确认：记住待删连接，在侧栏底部内联确认，不用 window.prompt。 */
  const [pendingDelete, setPendingDelete] = useState<Connection | null>(null)
  const [confirmName, setConfirmName] = useState('')
  const connections = useSshStore((state) => state.connections)
  const activeId = useSshStore((state) => state.activeId)
  const tmuxSessions = useSshStore((state) => state.tmuxSessions)
  const tmuxLoading = useSshStore((state) => state.tmuxLoading)
  const notice = useSshStore((state) => state.notice)
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

  const toggleExpand = (id: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAndExpand = (id: number): void => {
    setExpanded((current) => (current.has(id) ? current : new Set(current).add(id)))
    void selectConnection(id)
  }

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

  const renderSessionChildren = (connection: Connection) => {
    if (tmuxLoading) return <li className="ssh-tree-note">查询中…</li>
    if (tmuxSessions === null) {
      return (
        <li className={notice ? 'ssh-tree-note ssh-error-note' : 'ssh-tree-note'}>
          {notice ?? '远端无 tmux，连接后将回退普通 shell，断开即结束。'}
        </li>
      )
    }
    return (
      <>
        <SessionRow
          key="main"
          label="main"
          meta="默认会话 ssh-main"
          open={terminals.some(
            (tab) => tab.connectionId === connection.id && tab.tmuxSession === null,
          )}
          onClick={() => openTerminal(connection.id, null)}
        />
        {tmuxSessions.map((session) => (
          <SessionRow
            key={session.name}
            label={session.name}
            meta={new Date(session.created * 1000).toLocaleString()}
            attached={session.attached}
            open={terminals.some(
              (tab) =>
                tab.connectionId === connection.id &&
                (tab.tmuxSession ?? 'main') === session.name,
            )}
            onClick={() => openTerminal(connection.id, session.name)}
          />
        ))}
        {tmuxSessions.length === 0 ? <li className="ssh-tree-note">远端暂无 tmux 会话</li> : null}
      </>
    )
  }

  return (
    <div className="ssh-tree" onContextMenu={(event) => openContextMenu(event, null)}>
      <div className="ssh-sidebar-head">
        <div className="ssh-sidebar-title">SSH</div>
        {activeId !== null ? (
          <button
            type="button"
            className="ssh-mini-btn"
            title="刷新 tmux 会话列表"
            aria-label="刷新 tmux 会话列表"
            onClick={() => void refreshTmuxSessions()}
          >
            ↻
          </button>
        ) : null}
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
          const selected = connection.id === activeId
          const hasChildren = selected && expanded.has(connection.id)
          return (
            <li key={connection.id} className="ssh-tree-node">
              <div
                className={selected ? 'ssh-tree-row active' : 'ssh-tree-row'}
                onClick={() => selectAndExpand(connection.id)}
                onContextMenu={(event) => openContextMenu(event, connection)}
                title={connection.command}
              >
                <button
                  type="button"
                  className={hasChildren ? 'ssh-tree-chevron open' : 'ssh-tree-chevron'}
                  aria-label={hasChildren ? '收起' : '展开'}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (!selected) selectAndExpand(connection.id)
                    else toggleExpand(connection.id)
                  }}
                >
                  ▸
                </button>
                <span className="ssh-tree-label">{connection.name}</span>
              </div>
              {hasChildren ? <ul className="ssh-tree-children">{renderSessionChildren(connection)}</ul> : null}
            </li>
          )
        })}
        {connections.length === 0 ? <li className="ssh-empty">右键新建连接</li> : null}
      </ul>
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

/** 会话子行：open 状态标 ●（已有标签），attached 数用于远端客户端提示。 */
function SessionRow({
  label,
  meta,
  open,
  attached,
  onClick,
}: {
  label: string
  meta: string
  open: boolean
  attached?: number
  onClick: () => void
}) {
  return (
    <li className={open ? 'ssh-tree-row child active' : 'ssh-tree-row child'} onClick={onClick}>
      <span className="ssh-tree-label">
        {label}
        {open ? ' ●' : attached && attached > 0 ? ' ○' : ''}
      </span>
      <span className="ssh-tree-meta">{meta}</span>
    </li>
  )
}

