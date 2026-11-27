import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '@/lib/ui'

/*
 * 工作区（任务表格、任务图）的右键菜单。侧边栏的菜单已收进 @ursi/sidebar，
 * 这里只服务工作区：它仍用 position: fixed + body portal，因为任务图是整页滚动的
 * 画布，菜单要越过多个滚动容器。迁入 @ursi/sidebar 需要先给工作区找一个不滚动的
 * 定位容器，属于另一件事。
 */
export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  /** 菜单项左侧的图标，例如状态图标。 */
  icon?: ReactNode
  /** 当前选中项，右侧显示对勾。 */
  checked?: boolean
  /** 不可选的目标，菜单里保留但仍然显示，解释当前可用的下一步。 */
  disabled?: boolean
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

/** 列表右键菜单，点空白、按 Esc、滚动或改变窗口大小时关闭。 */
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
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
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
          disabled={item.disabled}
          className={cx(
            'context-menu-item',
            item.danger && 'danger',
            item.checked && 'is-checked',
          )}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.icon ? <span className="context-menu-icon">{item.icon}</span> : null}
          <span className="context-menu-label">{item.label}</span>
          {item.checked ? (
            <span className="context-menu-check" aria-hidden="true">
              ✓
            </span>
          ) : null}
        </button>
      ))}
    </div>,
    document.body,
  )
}
