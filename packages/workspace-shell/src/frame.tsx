import type { ReactNode } from 'react'
import './shell.css'

export interface SidebarFrameProps {
  title: string
  collapsed: boolean
  collapse: () => void
  expand: () => void
  /** 折叠条上的关键信息，控制在 2–3 项短值。 */
  items?: Array<{ label: string; value: string }>
  /** 标题行右侧的额外按钮（搜索、过滤），排在折叠按钮之前。 */
  actions?: ReactNode
  children?: ReactNode
}

/**
 * 侧边栏内容的标准外框：展开态渲染「标题 + 折叠按钮 + 内容」，
 * 折叠态渲染一条可点击的横向窄条。折叠是上下方向：按钮用 ↑ / ↓，
 * 不用左右箭头，因为侧边栏堆叠的是高度而不是宽度。
 */
export function SidebarFrame({
  title,
  collapsed,
  collapse,
  expand,
  items = [],
  actions,
  children,
}: SidebarFrameProps) {
  if (collapsed) {
    const text = [title, ...items.map((item) => `${item.label}: ${item.value}`)].join(' · ')
    return (
      <button
        type="button"
        className="ws-section-rail"
        title={`展开 ${title}`}
        aria-label={`${text}。展开 ${title}`}
        onClick={expand}
      >
        <span className="ws-section-rail-toggle" aria-hidden="true">
          ↓
        </span>
        <span className="ws-section-rail-title">{title}</span>
        {items.map((item) => (
          <span key={item.label} className="ws-section-rail-item">
            <span className="ws-section-rail-label">{item.label}</span>
            <span className="ws-section-rail-value">{item.value}</span>
          </span>
        ))}
      </button>
    )
  }

  return (
    <div className="ws-section">
      <header className="ws-section-head">
        <span className="ws-section-title">{title}</span>
        {actions}
        <button
          type="button"
          className="ws-section-toggle"
          title={`折叠 ${title}`}
          aria-label={`折叠 ${title}`}
          onClick={collapse}
        >
          ↑
        </button>
      </header>
      <div className="ws-section-body">{children}</div>
    </div>
  )
}
