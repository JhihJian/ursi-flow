import { Link, NavLink } from 'react-router'
import { Icon } from '@/shared/ui/icon'
import { setToken } from '@/shared/http/session'
import { useThemeStore } from './theme'
import type { NavGroup } from './navigation'

export function AppSidebar({ groups, signedIn, onNavigate }: { groups: NavGroup[]; signedIn: boolean; onNavigate?: () => void }) {
  const { mode, palette, toggleTheme, togglePalette } = useThemeStore()
  const dark = mode === 'dark'
  const mono = palette === 'mono'
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Link to="/items" aria-label="ursi-flow 首页" onClick={onNavigate} className="flex items-center gap-3 px-5 py-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-primary-foreground"><Icon name="workflow" size={23} /></span>
        <span><strong className="block text-[17px] font-semibold text-txt">ursi-flow</strong><span className="text-xs text-txt3">工作台</span></span>
      </Link>
      <nav aria-label="主导航" className="scroll-area min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-2">
        {groups.map(group => <section key={group.title}>
          <h2 className="mb-1 px-3 text-xs font-medium text-txt3">{group.title}</h2>
          {group.items.map(item => <NavLink key={item.path} to={item.path} onClick={onNavigate} className={({ isActive }) => isActive ? 'sidebar-link nav-active' : 'sidebar-link'}>
            <Icon name={item.icon} size={18} />{item.title}
          </NavLink>)}
        </section>)}
      </nav>
      <div className="mx-3 my-2 border-t border-line pt-2">
        <button type="button" className="sidebar-link w-full" aria-label={dark ? '切换到亮色主题' : '切换到暗色主题'} onClick={toggleTheme}>
          <Icon name={dark ? 'sun' : 'moon'} />{dark ? '亮色外观' : '暗色外观'}
        </button>
        <button type="button" className="sidebar-link w-full" aria-label={mono ? '切换到彩色主题' : '切换到黑白主题'} onClick={togglePalette}>
          <Icon name="contrast" />{mono ? '彩色主题' : '黑白主题'}
        </button>
        {signedIn && <button type="button" className="sidebar-link w-full" onClick={() => { setToken(''); onNavigate?.() }}><Icon name="logout" />退出登录</button>}
      </div>
    </div>
  )
}
