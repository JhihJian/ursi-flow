import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { SessionRow } from '../api'
import type { SessionGroup } from '../lib/format'
import { sessionTitle } from '../lib/format'
import type { MenuItem, MenuState } from '../components/ContextMenu'

interface MenuActions {
  select: (row: SessionRow) => void
  deleteSession: (row: SessionRow) => void
  togglePin: (projectKey: string, pinned: boolean) => void
}

/**
 * 侧栏的右键菜单：项目组菜单、会话行菜单，以及删除的原位二次确认。
 *
 * 确认层要落在刚才菜单的位置上，但那时菜单 state 已经清空，所以坐标另存一份。
 */
export function useSidebarMenu({ select, deleteSession, togglePin }: MenuActions) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuAt = useRef({ x: 0, y: 0 })

  const openMenu = useCallback((event: ReactMouseEvent, items: MenuItem[], heading?: string) => {
    event.preventDefault()
    event.stopPropagation()
    menuAt.current = { x: event.clientX, y: event.clientY }
    setMenu({ x: event.clientX, y: event.clientY, items, heading })
  }, [])

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

  /** 会话行右键：打开、复制标识与路径、删除。 */
  const sessionMenu = useCallback(
    (event: ReactMouseEvent, row: SessionRow) => {
      openMenu(
        event,
        [
          { label: '打开', onSelect: () => select(row) },
          { label: '复制会话 ID', onSelect: () => void navigator.clipboard?.writeText(row.id) },
          { label: '复制文件路径', onSelect: () => void navigator.clipboard?.writeText(row.path) },
          { label: '删除会话…', danger: true, onSelect: () => confirmDelete(row) },
        ],
        sessionTitle(row),
      )
    },
    [openMenu, select, confirmDelete],
  )

  const close = useCallback(() => setMenu(null), [])

  return { menu, close, projectMenu, sessionMenu }
}
