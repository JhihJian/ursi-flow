import { useEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { SandboxSidebar } from './SandboxSidebar'
import { SandboxWorkspace } from './SandboxWorkspace'

const NARROW = '(max-width: 767px)'

/**
 * 独立部署布局：左栏模块导航与实例列表，右栏路由内容。
 * 窄屏时列表页展开侧栏、详情与配置页收起成窄条，给内容留出宽度。
 */
export function SandboxStandalone() {
  const { pathname } = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW).matches,
  )

  useEffect(() => {
    const query = window.matchMedia(NARROW)
    const sync = () => setNarrow(query.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    if (!narrow) return
    setCollapsed(!(pathname === '/' || pathname === '/sandboxes'))
  }, [narrow, pathname])

  return (
    <div className={collapsed ? 'sbx-standalone is-collapsed' : 'sbx-standalone'}>
      <div className="sbx-standalone-side">
        <SandboxSidebar
          collapsed={collapsed}
          collapse={() => setCollapsed(true)}
          expand={() => setCollapsed(false)}
        />
      </div>
      <div className="sbx-standalone-main">
        <SandboxWorkspace />
      </div>
    </div>
  )
}
