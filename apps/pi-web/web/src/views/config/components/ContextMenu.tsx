import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 右键菜单（参照 apps/fs-web 的 ContextMenu）。
 * 点空白、按 Esc、滚动或改变窗口大小时关闭；删除确认复用同一个菜单。
 */

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
}

export interface MenuState {
  x: number
  y: number
  /** 菜单顶部的说明行，用于删除确认等场景。 */
  heading?: string
  items: MenuItem[]
}

const MENU_WIDTH = 200
const ITEM_HEIGHT = 30

export function ContextMenu({ state, onClose }: { state: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!state) {
      setPosition(null)
      return
    }
    const height = state.items.length * ITEM_HEIGHT + (state.heading ? ITEM_HEIGHT : 0)
    setPosition({
      left: Math.max(4, Math.min(state.x, window.innerWidth - MENU_WIDTH - 4)),
      top: Math.max(4, Math.min(state.y, window.innerHeight - height - 8)),
    })
  }, [state])

  useEffect(() => {
    if (!state) return
    const close = () => onClose()
    const onPointerDown = (event: PointerEvent) => {
      // 捕获阶段先于菜单内的点击触发，点菜单本身不能关掉它。
      if (ref.current?.contains(event.target as Node)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const onScroll = (event: Event) => {
      // 页面滚动时跟随关闭；菜单自身内滚不关。
      if (ref.current?.contains(event.target as Node)) return
      onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [state, onClose])

  if (!state || !position) return null

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: position.left, top: position.top, width: MENU_WIDTH }}
    >
      {state.heading ? <div className="context-menu-heading">{state.heading}</div> : null}
      {state.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? 'context-menu-item danger' : 'context-menu-item'}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
