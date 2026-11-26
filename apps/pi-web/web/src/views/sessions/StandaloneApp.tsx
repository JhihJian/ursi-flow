import { useMemo, useState } from 'react'
import { SessionsSidebar } from './components/SessionsSidebar'
import { createPiSessionsModule } from './module'

/**
 * 独立入口：不接外壳也能用，直接摆两栏。
 *
 * 侧边栏与工作区复用模块里的同一对组件，Provider 取自模块工厂，
 * 因此这里没有第二套状态逻辑；折叠状态在独立入口里由本组件自己持有。
 */
export function StandaloneApp() {
  const [collapsed, setCollapsed] = useState(false)
  // 工厂在渲染间保持稳定，避免每次重渲染都换一份 Provider（会清空列表状态）。
  const mod = useMemo(
    () =>
      createPiSessionsModule({
        apiBaseUrl: '/api',
        storageKey: 'pi-web.sessions',
        readRootFromUrl: true,
      }),
    [],
  )
  const Provider = mod.Provider!
  // 工作区直接用模块里那个（内部 lazy 加载轨迹组件库），独立入口与嵌入共用一份实现。
  const Workspace = mod.Workspace
  const sidebarProps = {
    collapsed,
    collapse: () => setCollapsed(true),
    expand: () => setCollapsed(false),
  }

  return (
    <Provider>
      <div className={collapsed ? 'solo solo-collapsed' : 'solo'}>
        <aside className="solo-sidebar">
          <SessionsSidebar {...sidebarProps} />
        </aside>
        <main className="solo-workspace">
          <Workspace />
        </main>
      </div>
    </Provider>
  )
}
