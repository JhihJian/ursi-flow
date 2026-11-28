import { useState, type MouseEvent } from 'react'
import { ContextMenu, SidebarGroup, SidebarRow, type MenuState } from '@ursi/sidebar'
import { TmuxInstallHint } from './TmuxInstallHint'
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
  /** 移除 tmux 会话确认：记住待移除的连接与会话，同样走侧栏底部内联确认。 */
  const [pendingKill, setPendingKill] = useState<{ connection: Connection; session: string } | null>(null)
  const [killConfirmName, setKillConfirmName] = useState('')
  const connections = useSshStore((state) => state.connections)
  const activeId = useSshStore((state) => state.activeId)
  const notice = useSshStore((state) => state.notice)
  const sessionsByConnection = useSshStore((state) => state.sessionsByConnection)
  const terminals = useSshStore((state) => state.terminals)
  const selectConnection = useSshStore((state) => state.selectConnection)
  const openTerminal = useSshStore((state) => state.openTerminal)
  const openSessionForm = useSshStore((state) => state.openSessionForm)
  const setEditor = useSshStore((state) => state.setEditor)
  const setBatchImportOpen = useSshStore((state) => state.setBatchImportOpen)
  const removeConnection = useSshStore((state) => state.removeConnection)
  const refreshTmuxSessions = useSshStore((state) => state.refreshTmuxSessions)
  const killTmuxSession = useSshStore((state) => state.killTmuxSession)

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
    // 行菜单与树的空白处菜单挂在同一条冒泡链上：不拦住会让行菜单被空白处菜单覆盖。
    event.preventDefault()
    event.stopPropagation()
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

  const openSessionContextMenu = (event: MouseEvent, connection: Connection, session: string) => {
    // 与连接行菜单一样拦住冒泡，避免触发树的空白处菜单。
    event.preventDefault()
    event.stopPropagation()
    setMenu(
      toMenuState(event, [
        {
          label: 'Remove session',
          danger: true,
          onSelect: () => {
            setPendingKill({ connection, session })
            setKillConfirmName('')
          },
        },
      ]),
    )
  }

  const toggleCollapse = (id: number): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
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

  const submitKill = () => {
    if (!pendingKill) return
    if (killConfirmName !== pendingKill.session) {
      store.getState().setNotice('名称不匹配，未移除。')
      return
    }
    const { connection, session } = pendingKill
    setPendingKill(null)
    setKillConfirmName('')
    killTmuxSession(connection.id, session).catch((error: unknown) => {
      store.getState().setNotice(error instanceof Error ? error.message : String(error))
    })
  }

  const renderSessionChildren = (connection: Connection, state: SessionsState | undefined) => {
    if (!state || state.loading) return <div className="ssh-tree-note">查询中…</div>
    if (state.error !== null) {
      return (
        <div className="ssh-tree-note ssh-error-note">
          {state.error}
          <TmuxInstallHint />
        </div>
      )
    }
    if (state.sessions === null) {
      return (
        <div className="ssh-tree-note">
          远端未安装 tmux，连接后将回退普通 shell，断开即结束。
          <TmuxInstallHint />
        </div>
      )
    }
    return (
      <>
        <SessionChildRow
          label="main"
          meta="默认会话 ssh-main"
          open={isOpen(connection.id, null)}
          onClick={() => openTerminal(connection.id, null)}
        />
        {state.sessions.map((session) => (
          <SessionChildRow
            key={session.name}
            label={session.name}
            meta={new Date(session.created * 1000).toLocaleString()}
            attached={session.attached}
            open={isOpen(connection.id, session.name)}
            onClick={() => openTerminal(connection.id, session.name)}
            onContextMenu={(event) => openSessionContextMenu(event, connection, session.name)}
          />
        ))}
        {state.sessions.length === 0 ? <div className="ssh-tree-note">远端暂无 tmux 会话</div> : null}
      </>
    )
  }

  return (
    <div className="ssh-tree" onContextMenu={(event) => openContextMenu(event, null)}>
      <div className="ssh-sidebar-head">
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
          title="从本机 ssh config 批量导入连接"
          aria-label="批量导入连接"
          onClick={() => setBatchImportOpen(true)}
        >
          ⇩
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
      <div className="ssh-item-list">
        {connections.map((connection) => {
          const expanded = !collapsed.has(connection.id)
          const selected = connection.id === activeId
          return (
            <SidebarGroup
              key={connection.id}
              className="ssh-tree-row parent"
              open={expanded}
              onToggle={() => {
                toggleCollapse(connection.id)
                void selectConnection(connection.id)
              }}
              active={selected}
              onContextMenu={(event) => openContextMenu(event, connection)}
              title={connection.command}
              label={connection.name}
            >
              {renderSessionChildren(connection, sessionsByConnection[connection.id])}
            </SidebarGroup>
          )
        })}
        {connections.length === 0 ? <div className="ssh-empty">右键新建连接</div> : null}
      </div>
      {notice && !pendingDelete && !pendingKill ? <div className="ssh-tree-note ssh-error-note">{notice}</div> : null}
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
      {pendingKill ? (
        <div className="ssh-confirm">
          <div className="ssh-confirm-text">
            移除 tmux 会话 <b>{pendingKill.session}</b>（其中进程一并结束）。输入会话名确认：
          </div>
          <input
            className="ssh-input"
            autoFocus
            value={killConfirmName}
            onChange={(event) => setKillConfirmName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitKill()
              if (event.key === 'Escape') {
                setPendingKill(null)
                setKillConfirmName('')
              }
            }}
          />
          <div className="ssh-confirm-actions">
            <button type="button" className="ssh-btn ssh-btn-danger" onClick={submitKill}>
              移除
            </button>
            <button
              type="button"
              className="ssh-btn"
              onClick={() => {
                setPendingKill(null)
                setKillConfirmName('')
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
      <ContextMenu state={menu} onClose={() => setMenu(null)} container={container} />
    </div>
  )
}

/** 会话子行：label 与标签栏内容一致；attached > 0 时在 meta 标 ●（远端有客户端）。 */
function SessionChildRow({
  label,
  meta,
  attached,
  open,
  onClick,
  onContextMenu,
}: {
  label: string
  meta: string
  attached?: number
  open: boolean
  onClick: () => void
  onContextMenu?: (event: MouseEvent) => void
}) {
  const attachedNote =
    attached !== undefined && attached > 0
      ? `${attached} client${attached === 1 ? '' : 's'} attached`
      : undefined
  return (
    <SidebarRow
      className="ssh-tree-row child"
      active={open}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={attachedNote}
      label={
        <>
          {label}
          {open ? ' ●' : ''}
        </>
      }
      meta={meta}
    />
  )
}
