import { useState, type MouseEvent } from 'react'
import { ContextMenu, type MenuState } from './ContextMenu'
import { useSshContainer, useSshController, useSshStore } from '../ssh-context'
import { LOCAL_CONNECTION_ID } from '../api/client'
import type { Connection } from '../api/types'

/** 一级侧栏：SSH 连接管理。点击只选中连接（联动下方会话列表），不建连。 */
export function ConnectionSidebar() {
  const container = useSshContainer()
  const { store } = useSshController()
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** 删除确认：记住待删连接，在侧栏底部内联确认，不用 window.prompt。 */
  const [pendingDelete, setPendingDelete] = useState<Connection | null>(null)
  const [confirmName, setConfirmName] = useState('')
  const connections = useSshStore((state) => state.connections)
  const activeId = useSshStore((state) => state.activeId)
  const selectConnection = useSshStore((state) => state.selectConnection)
  const setEditor = useSshStore((state) => state.setEditor)
  const removeConnection = useSshStore((state) => state.removeConnection)

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
    // 本机连接是固定入口，不提供编辑与删除。
    if (connection && connection.id !== LOCAL_CONNECTION_ID) {
      items.push(
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

  return (
    <div className="ssh-connections" onContextMenu={(event) => openContextMenu(event, null)}>
      <div className="ssh-sidebar-head">
        <div className="ssh-sidebar-title">SSH</div>
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
        {connections.map((connection) => (
          <li
            key={connection.id}
            className={connection.id === activeId ? 'ssh-item active' : 'ssh-item'}
            onClick={() => void selectConnection(connection.id)}
            onContextMenu={(event) => openContextMenu(event, connection)}
          >
            <span className="ssh-item-name">{connection.name}</span>
            <span className="ssh-item-meta">{connection.command}</span>
          </li>
        ))}
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
