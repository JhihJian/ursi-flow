/**
 * 模块根节点。
 *
 * - `.sbx-app` 根类是全部样式的作用域锚点（tokens.css、style.css、tailwind
 *   `important: '.sbx-app'` 都指向它），独立部署与嵌入外壳共用。
 * - 通过 ref 把自身 DOM 节点提供给 Radix Portal（dialog / alert-dialog /
 *   dropdown-menu），让浮层挂回模块内部，避免模块契约禁止的全局固定定位。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { OverlayContainerContext } from './shared/lib/utils'
import './tokens.css'
import './style.css'

export function AppRoot({ children }: { children: ReactNode }) {
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setRoot(ref.current)
  }, [])
  return (
    <OverlayContainerContext.Provider value={root}>
      <div ref={ref} className="sbx-app">
        {children}
      </div>
    </OverlayContainerContext.Provider>
  )
}
