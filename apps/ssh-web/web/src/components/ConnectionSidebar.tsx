import { useState, type MouseEvent } from 'react'
import { ContextMenu, type MenuState } from './ContextMenu'
import { useSshStore } from '../store/ssh-store'
import type { Connection } from '../api/types'

/** 一级侧栏：SSH 连接管理。点击只选中连接（联动二级会话列表），不建连。 */
export function ConnectionSidebar() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const connections = useSshStore((state) => state.connections)
  const activeId = useSshStore((state) => state.activeId)
  const selectConnection = useSshStore((state) => state.selectConnection)
  const setEditor = useSshStore((state) => state.setEditor)
  const removeConnection = useSshStore((state) => state.removeConnection)

  const confirmAndDelete = (connection: Connection) => {
    const name = window.prompt(`输入连接名称以确认删除 "${connection.name}"`)
    if (name === null) return
    if (name !== connection.name) {
      useSshStore.getState().setNotice('名称不匹配，未删除。')
      return
    }
    removeConnection(connection.id).catch((error: unknown) => {
      useSshStore.getState().setNotice(error instanceof Error ? error.message : String(error))
    })
  }

  const openContextMenu = (event: MouseEvent, connection: Connection | null) => {
    event.preventDefault()
    const items: MenuState['items'] = [
      { label: 'New connection', onSelect: () => setEditor({ kind: 'new' }) },
    ]
    if (connection) {
      items.push(
        { label: 'Edit', onSelect: () => setEditor({ kind: 'edit', connection }) },
        { label: 'Delete', danger: true, onSelect: () => confirmAndDelete(connection) },
      )
    }
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  return (
    <div className="sidebar" onContextMenu={(event) => openContextMenu(event, null)}>
      <div className="sidebar-head">
        <div className="sidebar-title">SSH</div>
        <button
          type="button"
          className="rail-toggle"
          aria-label="新建连接"
          onClick={() => setEditor({ kind: 'new' })}
        >
          +
        </button>
      </div>
      <ul className="connection-list">
        {connections.map((connection) => (
          <li
            key={connection.id}
            className={connection.id === activeId ? 'connection-item active' : 'connection-item'}
            onClick={() => void selectConnection(connection.id)}
            onContextMenu={(event) => openContextMenu(event, connection)}
          >
            <span className="name">{connection.name}</span>
            <span className="meta">{connection.command}</span>
          </li>
        ))}
        {connections.length === 0 ? <li className="empty-state">右键新建连接</li> : null}
      </ul>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
