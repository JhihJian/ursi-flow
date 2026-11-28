import type { MouseEvent, ReactNode } from 'react'
import { cx } from './cx'

export interface SidebarRowProps {
  /**
   * 根元素标签。默认 button，行天然可点、可聚焦、可被键盘触发。
   * 行里要嵌套按钮（如折叠 chevron）时用 div，HTML 不允许 button 嵌套 button；
   * 此时键盘可达由内嵌按钮自己保证。
   */
  as?: 'button' | 'div'
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
  /** 主标签，超出截断。 */
  label: ReactNode
  /** 说明，在主标签下方一行，超出截断。没有就是单行。 */
  meta?: ReactNode
  /** 主标签左侧：图标、折叠按钮。 */
  leading?: ReactNode
  /** 行尾右侧：徽标、状态标记。 */
  trailing?: ReactNode
  /** 渲染在说明下方的其它内容。 */
  children?: ReactNode
  /** data-* 属性原样挂到根元素，用于定位（如按 id 找到行再弹确认菜单）。 */
  [key: `data-${string}`]: string | undefined
}

/**
 * 侧边栏列表的一行：主标签 + 说明（可选）。
 * 管：选中态、hover 灰底、左侧竖线、文字截断，外加 click / contextmenu / ref 三个口子。
 * 行里多出来的东西（拖放、折叠按钮、内联编辑）由调用方用 className、rowRef、
 * leading、trailing、children 自己接。
 */
export function SidebarRow({
  as = 'button',
  active,
  title,
  ariaCurrent,
  onClick,
  onContextMenu,
  className,
  rowRef,
  label,
  meta,
  leading,
  trailing,
  children,
  ...rest
}: SidebarRowProps) {
  const data = Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith('data-')))
  const Tag = as
  return (
    <Tag
      type={as === 'button' ? 'button' : undefined}
      ref={rowRef}
      {...data}
      title={title}
      aria-current={ariaCurrent}
      className={cx('sb-row', active && 'is-active', className)}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {leading ? <span className="sb-leading">{leading}</span> : null}
      <span className="sb-main">
        <span className="sb-label">{label}</span>
        {meta !== undefined && meta !== null ? <span className="sb-meta">{meta}</span> : null}
        {children}
      </span>
      {trailing ? <span className="sb-trailing">{trailing}</span> : null}
    </Tag>
  )
}
