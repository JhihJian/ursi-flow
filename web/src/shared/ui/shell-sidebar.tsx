import { NavLink, Link } from 'react-router'

import { cn } from '@/shared/lib/utils'
import { Icon } from './icon'

export interface ShellNavItem {
  path: string
  title: string
  icon: string
}

export interface ShellNavGroup {
  title: string
  items: ShellNavItem[]
}

export interface ShellSidebarProps {
  groups: ShellNavGroup[]
  /** 当前是否为暗色主题，决定主题按钮文案与图标。 */
  dark: boolean
  /** 演示模式下展示演示设置入口。 */
  demo: boolean
  onNavigate?: () => void
  onTheme?: () => void
  onSettings?: () => void
  className?: string
}

/** 侧边导航：桌面固定栏与移动抽屉共用同一份结构与文案。 */
export function ShellSidebar({ groups, dark, demo, onNavigate, onTheme, onSettings, className }: ShellSidebarProps) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <Link to="/workflows" className="flex items-center gap-3 px-5 py-6" aria-label="ursi-flow 首页" onClick={onNavigate}>
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-white">
          <Icon name="workflow" size={23} />
        </span>
        <span>
          <span className="block text-[17px] font-semibold tracking-tight text-txt">ursi-flow</span>
          <span className="mt-0.5 block text-[11px] tracking-wide text-txt3">流程与 Agent 协作</span>
        </span>
      </Link>
      <nav aria-label="主导航" className="scroll-area min-h-0 flex-1 space-y-7 overflow-y-auto px-3 py-4">
        {groups.map((group) => (
          <section key={group.title}>
            <h2 className="mb-2 px-3 text-[11px] font-medium tracking-wider text-txt3">{group.title}</h2>
            <div className="space-y-1">
              {group.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) => cn('sidebar-link', isActive && 'nav-active')}
                  onClick={onNavigate}
                >
                  <Icon name={item.icon} size={18} />
                  <span>{item.title}</span>
                </NavLink>
              ))}
            </div>
          </section>
        ))}
      </nav>
      <div className="mx-3 mb-3 border-t border-line pt-3">
        <button
          type="button"
          className="sidebar-link w-full"
          aria-label={dark ? '切换到亮色主题' : '切换到暗色主题'}
          onClick={onTheme}
        >
          <Icon name={dark ? 'sun' : 'moon'} />
          <span>{dark ? '亮色外观' : '暗色外观'}</span>
        </button>
        {demo ? (
          <button type="button" className="sidebar-link w-full" onClick={onSettings}>
            <Icon name="flask" />
            <span>演示模式</span>
            <Icon name="settings" size={14} className="ml-auto text-txt3" />
          </button>
        ) : (
          <div className="flex items-center gap-3 px-3 py-2.5 text-sm text-txt3">
            <Icon name="server" />
            <span>真实服务</span>
          </div>
        )}
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-line bg-surface p-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-dim text-xs font-semibold text-accent-2" aria-hidden="true">
            UF
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-txt">默认工作区</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-txt3">
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', demo ? 'bg-accent' : 'bg-info')} aria-hidden="true" />
              {demo ? '演示工作区' : '真实服务'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
