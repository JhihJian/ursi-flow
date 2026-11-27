import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  /** 禁用时仍显示在菜单里，用 `reason` 说明为什么不能点。 */
  disabled?: boolean
  reason?: string
  /** 菜单项左侧的图标。 */
  icon?: ReactNode
  /** 当前选中项，右侧显示对勾。 */
  checked?: boolean
}

export interface MenuState {
  /** 相对 `container` 的坐标：clientX/Y 减去容器 rect。 */
  x: number
  y: number
  /** 菜单顶部的说明行，用于删除确认等场景。 */
  heading?: string
  items: MenuItem[]
}

export interface ContextMenuProps {
  state: MenuState | null
  onClose: () => void
  /**
   * 挂载容器，通常是模块根元素。浮层只在模块自己的区域内定位，
   * 不用全局 position: fixed，多区域布局下坐标才不会错位。
   * ref 回调首次给 null，此时不渲染。
   */
  container: HTMLElement | null
}

const MENU_WIDTH = 200
const ITEM_HEIGHT = 30
const EDGE_PAD = 4
const BOTTOM_PAD = 8

/** 菜单高度：每个菜单项一行，标题也占一行。 */
function menuHeightOf(state: MenuState): number {
  return state.items.length * ITEM_HEIGHT + (state.heading ? ITEM_HEIGHT : 0)
}

/**
 * 右键菜单，渲染在模块容器内（absolute），不进 document.body，
 * 保证菜单不越过模块边界，也不吃宿主全局样式。
 * 点空白、Esc、滚动或窗口变化时关闭。
 */
export function ContextMenu({ state, onClose, container }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  // onClose 常是调用方的内联箭头函数，用 ref 持最新值，监听只在菜单开合时挂一次。
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const close = () => onCloseRef.current()
  // 打开前的焦点元素：关闭后还回去，键盘用户不会丢位置。
  // 只在「无 → 有」时记，「有 → 换一个菜单」（二次确认）不重记，否则会记成正在卸载的旧菜单项。
  const openerRef = useRef<HTMLElement | null>(null)
  const open = state !== null
  const prevOpen = useRef(false)
  useEffect(() => {
    if (open && !prevOpen.current) openerRef.current = document.activeElement as HTMLElement | null
    if (!open && prevOpen.current) {
      openerRef.current?.focus?.()
      openerRef.current = null
    }
    prevOpen.current = open
  }, [open])

  useLayoutEffect(() => {
    if (!state || !container) {
      setPosition(null)
      return
    }
    const rect = container.getBoundingClientRect()
    const height = menuHeightOf(state)
    // 右侧放不下就左翻到指针左边；翻过去也放不下（窄栏）就贴左，宁可裁掉也不越出容器。
    let left = state.x
    if (left + MENU_WIDTH + EDGE_PAD > rect.width) left = state.x - MENU_WIDTH - EDGE_PAD
    left = Math.max(EDGE_PAD, left)
    const top = Math.max(EDGE_PAD, Math.min(state.y, rect.height - height - BOTTOM_PAD))
    setPosition({ left, top })
  }, [state, container])

  // 只有菜单真正渲染出来才挂监听：容器尚未挂载时菜单不可见，Esc 不该触发 onClose。
  useEffect(() => {
    if (!state || !position) return
    const onPointerDown = (event: PointerEvent) => {
      // 捕获阶段先于菜单内的点击触发，点菜单本身不能关掉它。
      if (ref.current?.contains(event.target as Node)) return
      close()
      // 不让这次 pointerdown 继续触发宿主行为（如折叠面板）。
      event.stopPropagation()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const onScroll = (event: Event) => {
      // 页面滚动时跟随关闭；菜单自身内滚不关。
      if (ref.current?.contains(event.target as Node)) return
      close()
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
  }, [state, position])

  if (!state || !container || !position) return null

  return createPortal(
    <div
      ref={(node) => {
        ref.current = node
        // 菜单挂载后焦点进第一个可用项；关闭时上面的 effect 还回去。
        node?.querySelector<HTMLButtonElement>('.sb-menu-item:not(:disabled)')?.focus()
      }}
      className="sb-menu"
      role="menu"
      style={{ left: position.left, top: position.top, width: MENU_WIDTH }}
    >
      {state.heading ? <div className="sb-menu-heading">{state.heading}</div> : null}
      {state.items.map((item, index) => (
        <button
          key={`${item.label}-${index}`}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          title={item.disabled ? item.reason : undefined}
          className={
            item.danger
              ? 'sb-menu-item danger'
              : item.checked
                ? 'sb-menu-item is-checked'
                : 'sb-menu-item'
          }
          onClick={() => {
            if (item.disabled) return
            close()
            item.onSelect()
          }}
        >
          {item.icon ? <span className="sb-menu-icon">{item.icon}</span> : null}
          <span className="sb-menu-label">{item.label}</span>
          {item.checked ? (
            <span className="sb-menu-check" aria-hidden="true">
              ✓
            </span>
          ) : null}
        </button>
      ))}
    </div>,
    container,
  )
}
