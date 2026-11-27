import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { SessionRow } from '../api'
import type { SessionGroup } from '../lib/format'
import { sessionTitle } from '../lib/format'
import type { MenuItem, MenuState } from '@ursi/sidebar'

interface MenuActions {
  deleteSession: (row: SessionRow) => void
  togglePin: (projectKey: string, pinned: boolean) => void
  /** 释放本进程装配的运行时，文件不动。 */
  evictSession: (sessionId: string) => void
  /** 本进程装配过的会话 id：只有这些行才能释放运行时。 */
  localSessionIds: ReadonlySet<string>
}

/**
 * 侧栏的右键菜单：项目组菜单、会话行菜单，以及删除的原位二次确认。
 *
 * 确认层要落在刚才菜单的位置上，但那时菜单 state 已经清空，所以坐标另存一份。
 */
export function useSidebarMenu({
  deleteSession,
  togglePin,
  evictSession,
  localSessionIds,
  menuContainer,
}: MenuActions & { menuContainer: HTMLElement | null }) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuAt = useRef({ x: 0, y: 0 })

  /** 把视口坐标换成菜单容器坐标；容器未挂载时不开菜单。 */
  const openMenu = useCallback(
    (event: ReactMouseEvent, items: MenuItem[], heading?: string) => {
      event.preventDefault()
      event.stopPropagation()
      if (!menuContainer) return
      const rect = menuContainer.getBoundingClientRect()
      menuAt.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      setMenu({ x: menuAt.current.x, y: menuAt.current.y, items, heading })
    },
    [menuContainer],
  )

  /** 项目组右键：关注 / 取消关注。 */
  const projectMenu = useCallback(
    (event: ReactMouseEvent, group: SessionGroup) => {
      const pinned = event.currentTarget.getAttribute('data-pinned') === 'true'
      openMenu(
        event,
        [{ label: pinned ? '取消特别关注' : '设为特别关注', onSelect: () => togglePin(group.key, !pinned) }],
        group.name,
      )
    },
    [openMenu, togglePin],
  )

  /**
   * 删除的二次确认：菜单已经关掉，用同一位置再弹一个菜单，
   * 确认项本身也带删除语义的颜色。
   */
  const confirmDelete = useCallback(
    (row: SessionRow) => {
      setMenu({
        x: menuAt.current.x,
        y: menuAt.current.y,
        heading: `删除「${sessionTitle(row)}」？`,
        items: [
          { label: '删除会话文件', danger: true, onSelect: () => deleteSession(row) },
          { label: '取消', onSelect: () => undefined },
        ],
      })
    },
    [deleteSession],
  )

  /** 会话行右键：复制标识与路径、释放运行时（仅本进程装配过的）、删除。打开就是单击行，不重复给。 */
  const sessionMenu = useCallback(
    (event: ReactMouseEvent, row: SessionRow) => {
      const assembled = localSessionIds.has(row.id)
      openMenu(
        event,
        [
          { label: '复制会话 ID', onSelect: () => void navigator.clipboard?.writeText(row.id) },
          { label: '复制文件路径', onSelect: () => void navigator.clipboard?.writeText(row.path) },
          {
            label: '释放运行时',
            onSelect: () => evictSession(row.id),
            disabled: !assembled,
            reason: '这条会话没有本进程的运行时',
          },
          { label: '删除会话…', danger: true, onSelect: () => confirmDelete(row) },
        ],
        sessionTitle(row),
      )
    },
    [openMenu, confirmDelete, evictSession, localSessionIds],
  )

  const close = useCallback(() => setMenu(null), [])

  return { menu, close, projectMenu, sessionMenu }
}
