import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSshContainer } from '../ssh-context'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
}

export interface MenuState {
  /** 相对模块容器的坐标（clientX/Y 减去容器 rect）。 */
  x: number
  y: number
  /** 菜单顶部的说明行，用于删除确认等场景。 */
  heading?: string
  items: MenuItem[]
}

const MENU_WIDTH = 200
const ITEM_HEIGHT = 30
const EDGE_PAD = 4

/**
 * 右键菜单，渲染在模块容器内（absolute），不再进 document.body，
 * 保证菜单不越过模块边界，也不吃宿主全局样式。点空白、Esc、滚动或窗口变化时关闭。
 */
export function ContextMenu({ state, onClose }: { state: MenuState | null; onClose: () => void }) {
  const container = useSshContainer()
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!state || !container) {
      setPosition(null)
      return
    }
    const rect = container.getBoundingClientRect()
    const height = state.items.length * ITEM_HEIGHT + (state.heading ? ITEM_HEIGHT : 0)
    let left = state.x - MENU_WIDTH - EDGE_PAD
    if (left < EDGE_PAD) left = Math.min(state.x + EDGE_PAD, rect.width - MENU_WIDTH - EDGE_PAD)
    // 窄栏左翻也放不下时按左对齐，宁可裁掉也不越出容器。
    if (left < EDGE_PAD) left = EDGE_PAD
    const top = Math.max(EDGE_PAD, Math.min(state.y, rect.height - height - 8))
    setPosition({ left, top })
  }, [state, container])

  useEffect(() => {
    if (!state) return
    const close = () => onClose()
    const onPointerDown = (event: PointerEvent) => {
      // 捕获阶段先于菜单内的点击触发，点菜单本身不能关掉它。
      if (ref.current?.contains(event.target as Node)) return
      onClose()
      // 不让这次 pointerdown 继续触发宿主行为（如折叠面板）。
      event.stopPropagation()
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

  if (!state || !container || !position) return null

  return createPortal(
    <div
      ref={ref}
      className="ssh-menu"
      role="menu"
      style={{ left: position.left, top: position.top, width: MENU_WIDTH }}
    >
      {state.heading ? <div className="ssh-menu-heading">{state.heading}</div> : null}
      {state.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? 'ssh-menu-item danger' : 'ssh-menu-item'}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    container,
  )
}
