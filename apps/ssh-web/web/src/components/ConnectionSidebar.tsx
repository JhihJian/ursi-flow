import type { MouseEvent } from 'react'
import type { MenuState } from './ContextMenu'
import { useSshStore } from '../store/ssh-store'
import type { Connection } from '../api/types'

interface SidebarProps {
  menu: { value: MenuState | null; set: (value: MenuState | null) => void }
}

/** 左侧连接列表：点击连接即建立 SSH 会话，右键打开新建/编辑/删除菜单。 */
export function ConnectionSidebar({ menu }: SidebarProps) {
  const connections = useSshStore((state) => state.connections)
  const activeId = useSshStore((state) => state.activeId)
  const connecting = useSshStore((state) => state.connecting)
  const selectConnection = useSshStore((state) => state.selectConnection)
  const setEditor = useSshStore((state) => state.setEditor)
  const removeConnection = useSshStore((state) => state.removeConnection)

  const openContextMenu = (event: MouseEvent, connection: Connection | null) => {
    event.preventDefault()
    const items: MenuState['items'] = [{ label: 'New connection', onSelect: () => setEditor({ kind: 'new' }) }]
    if (connection) {
      items.push(
        { label: 'Edit', onSelect: () => setEditor({ kind: 'edit', connection }) },
        {
          label: 'Delete',
          danger: true,
          onSelect: () => {
            const name = window.prompt(`输入连接名称以确认删除 "${connection.name}"`)
            if (name === null) return
            if (name !== connection.name) {
              useSshStore.getState().setNotice('名称不匹配，未删除。')
              return
            }
            removeConnection(connection.id).catch((error: unknown) => {
              useSshStore.getState().setNotice(
                error instanceof Error ? error.message : String(error),
              )
            })
          },
        },
      )
    }
    menu.set({ x: event.clientX, y: event.clientY, items })
  }

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title">Connections</div>
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
            className={
              connection.id === activeId
                ? 'connection-item active'
                : connecting && connection.id === activeId
                  ? 'connection-item loading'
                  : 'connection-item'
            }
            onClick={() => void selectConnection(connection.id)}
            onContextMenu={(event) => openContextMenu(event, connection)}
          >
            <span className="name">{connection.name}</span>
            <span className="meta">
              {connection.username}@{connection.host}:{connection.port}
            </span>
          </li>
        ))}
        {connections.length === 0 ? (
          <li className="empty-state">右键新建连接</li>
        ) : null}
      </ul>
    </div>
  )
}
