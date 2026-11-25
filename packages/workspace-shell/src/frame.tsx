import type { ReactNode } from 'react'
import './shell.css'

export interface SidebarFrameProps {
  title: string
  collapsed: boolean
  collapse: () => void
  expand: () => void
  /** 折叠条上的关键信息，控制在 2–3 项短值。 */
  items?: Array<{ label: string; value: string }>
  children?: ReactNode
}

/**
 * 侧边栏内容的标准外框：展开态渲染「标题 + 折叠按钮 + 内容」，
 * 折叠态渲染整条可点击的窄条。模块可以用它省掉重复的折叠 UI，
 * 也可以按同样形态自己实现，外壳只依赖 collapsed / collapse / expand 三个约定。
 */
export function SidebarFrame({
  title,
  collapsed,
  collapse,
  expand,
  items = [],
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
        <span className="ws-section-rail-toggle">»</span>
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
        <button
          type="button"
          className="ws-section-toggle"
          title={`折叠 ${title}`}
          aria-label={`折叠 ${title}`}
          onClick={collapse}
        >
          «
        </button>
      </header>
      <div className="ws-section-body">{children}</div>
    </div>
  )
}
