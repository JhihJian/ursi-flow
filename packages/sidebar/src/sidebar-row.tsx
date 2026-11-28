import type { MouseEvent, ReactNode } from 'react'
import { cx } from './cx'

export interface SidebarRowProps {
  /** 选中态：左侧竖线显色 + 灰底。 */
  active?: boolean
  /** 悬停提示。 */
  title?: string
  /** 当前项的 aria-current 值，通常是 'true' 或 'page'。 */
  ariaCurrent?: 'true' | 'page' | undefined
  onClick?: () => void
  onContextMenu?: (event: MouseEvent) => void
  /**
   * 根元素的额外类名。拖放态、错误态、模块自己的修饰类都从这里拼进来，
   * 组件不替调用方枚举业务状态。
   */
  className?: string
  /**
   * 根元素 ref。拖放库要拿 DOM 节点（dnd-kit 的 setNodeRef），或调用方要聚焦时用。
   * 与 React 的 ref 不同，这里是普通 prop，函数组件直接传即可。
   */
  rowRef?: (element: HTMLElement | null) => void
  /** 左侧主标签，超出截断。 */
  label: ReactNode
  /** 附加文字。inline 布局靠右、超出截断；stack 布局在标签下方、不截断。 */
  meta?: ReactNode
  /**
   * stack：标签在上、附加文字在下（todo 项目、pi 会话）。
   * inline：标签在左、附加文字靠右（ssh 子行、flow）。默认 inline。
   */
  layout?: 'inline' | 'stack'
  /** 标签前的图标或折叠按钮。 */
  leading?: ReactNode
  /** 标签后的徽标。 */
  trailing?: ReactNode
  /** 渲染在标签下方的其它内容（第二行路径、错误提示等）。 */
  children?: ReactNode
  /** data-* 属性原样挂到根元素，用于定位（如按 id 找到行再弹确认菜单）。 */
  [key: `data-${string}`]: string | undefined
}

/**
 * 侧边栏列表的一行。只管四件事：选中态、hover 灰底、左侧竖线、文字截断，
 * 外加 click / contextmenu / ref 三个口子。行里多出来的东西（拖放、折叠按钮、
 * 内联编辑）由调用方用 className、rowRef、leading、children 自己接。
 *
 * 根元素是 button：行天然是可点、可聚焦、可被键盘触发的。
 */
export function SidebarRow({
  active,
  title,
  ariaCurrent,
  onClick,
  onContextMenu,
  className,
  rowRef,
  label,
  meta,
  layout = 'inline',
  leading,
  trailing,
  children,
  ...rest
}: SidebarRowProps) {
  const data = Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith('data-')))
  return (
    <button
      type="button"
      ref={rowRef}
      {...data}
      title={title}
      aria-current={ariaCurrent}
      className={cx('sb-row', `sb-row--${layout}`, active && 'is-active', className)}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {leading ? <span className="sb-row-leading">{leading}</span> : null}
      <span className="sb-row-label">
        {label}
        {trailing}
      </span>
      {meta !== undefined && meta !== null ? <span className="sb-row-meta">{meta}</span> : null}
      {children}
    </button>
  )
}
