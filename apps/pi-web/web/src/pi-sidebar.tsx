import type { ComponentType, ReactNode } from 'react'
import type { ModuleSidebarProps, WorkspaceModule } from '@ursi/workspace-shell'
import { usePi, type PiView } from './pi-context'

/**
 * 侧栏：三个视图共用一个模块，顶部是视图切换，下面是当前视图自己的侧栏。
 *
 * home 选择留在各视图原有的入口里（它们都写回 PiProvider），所以三个视图
 * 看到的是同一份 home，不会出现「对话换了 home、会话还停在旧根」。
 *
 * 折叠时内层侧栏只隐藏不卸载：展开的组、显示更多、搜索框开关都是视图私有状态，
 * 卸载就全丢，用户点一下折叠再展开会回到初始样子。
 */

const VIEWS: Array<{ id: PiView; label: string }> = [
  { id: 'chat', label: '对话' },
  { id: 'sessions', label: '会话' },
  { id: 'config', label: '配置' },
]

type ViewModule = WorkspaceModule

export function PiSidebar({
  config,
  sessions,
  chat,
  ...props
}: ModuleSidebarProps & {
  config: ViewModule
  sessions: ViewModule
  chat: ViewModule
}): ReactNode {
  const { view, setView, loading, error, home } = usePi()
  const active = view === 'config' ? config : view === 'sessions' ? sessions : chat
  const Sidebar = active.Sidebar as ComponentType<ModuleSidebarProps>
  const label = VIEWS.find((item) => item.id === view)?.label ?? 'Pi'

  // 折叠态：外壳把这一节压到 32px，此时只留一条可点击的窄条，不渲染三段切换。
  // 内层侧栏用 hidden 藏起来而不是不渲染，展开后状态原样还在。
  if (props.collapsed) {
    return (
      <>
        <button
          type="button"
          className="pi-switch-rail"
          onClick={props.expand}
          aria-label={`Pi · ${label}${home ? ` · ${home.name}` : ''} · 展开`}
        >
          <span className="pi-switch-rail-arrow" aria-hidden="true">
            ↓
          </span>
          <span className="pi-switch-rail-label">Pi · {label}</span>
          <span className="pi-switch-rail-home">{home?.name ?? '未选 home'}</span>
        </button>
        <div className="pi-switch-keep" hidden>
          <Sidebar {...props} />
        </div>
      </>
    )
  }

  return (
    <div className="pi-switch-root">
      <div className="pi-switch" role="tablist" aria-label="Pi 视图">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className="pi-switch-tab"
            aria-selected={view === item.id}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {loading ? <p className="pi-switch-note">加载 pi home…</p> : null}
      {error ? <p className="pi-switch-note pi-switch-error">{error}</p> : null}
      {/* 折叠控制透传给当前视图自己的 SidebarFrame，外壳的高度仍由外壳管。 */}
      <Sidebar {...props} />
    </div>
  )
}
