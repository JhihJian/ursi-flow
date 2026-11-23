import { Link } from 'react-router'
import { Icon } from '@/shared/ui/icon'
import { setToken } from '@/shared/http/session'
import { isLanPreview } from '@/shared/http/lan-preview'
import { useThemeStore } from './theme'
import type { NavGroup } from './navigation'

export function AppSidebar({ groups, activePath, signedIn, onNavigate }: { groups: NavGroup[]; activePath?: string; signedIn: boolean; onNavigate?: () => void }) {
  const { mode, palette, toggleTheme, togglePalette } = useThemeStore()
  const dark = mode === 'dark'
  const mono = palette === 'mono'
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Link to="/work-items" aria-label="ursi-flow 首页" onClick={onNavigate} className="flex shrink-0 items-center gap-3 px-4 py-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-primary-foreground"><Icon name="workflow" size={23} /></span>
        <span><strong className="block text-[17px] font-semibold text-txt">ursi-flow</strong><span className="text-xs text-txt3">工作台</span></span>
      </Link>
      <nav aria-label="主导航" className="scroll-area min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2">
        {groups.map(group => <section key={group.title}>
          <h2 className="mb-1 px-3 text-xs font-medium text-txt3">{group.title}</h2>
          {group.items.map(item => {
            const icon = <Icon name={item.icon} size={17} />
            if (item.external) return <a key={item.path} href={item.path} className="sidebar-link" referrerPolicy="no-referrer" onClick={onNavigate}>{icon}{item.title}</a>
            const active = item.path === activePath
            return <Link key={item.path} to={item.path} onClick={onNavigate} aria-current={active ? (item.routeId ? 'true' : 'page') : undefined}
              className={active ? 'sidebar-link nav-active' : 'sidebar-link'}>{icon}{item.title}</Link>
          })}
        </section>)}
      </nav>
      <div className="mx-3 flex shrink-0 items-center gap-1 border-t border-line py-2">
        <button type="button" className="icon-button" title={dark ? '亮色外观' : '暗色外观'} aria-label={dark ? '切换到亮色主题' : '切换到暗色主题'} onClick={toggleTheme}>
          <Icon name={dark ? 'sun' : 'moon'} />
        </button>
        <button type="button" className="icon-button" title={mono ? '彩色主题' : '黑白主题'} aria-label={mono ? '切换到彩色主题' : '切换到黑白主题'} onClick={togglePalette}>
          <Icon name="contrast" />
        </button>
        {signedIn && !isLanPreview() && <button type="button" className="icon-button ml-auto" title="退出登录" aria-label="退出登录" onClick={() => { setToken(''); onNavigate?.() }}><Icon name="logout" /></button>}
      </div>
    </div>
  )
}
