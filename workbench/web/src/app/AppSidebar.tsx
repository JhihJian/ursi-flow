import { Link, NavLink, useLocation } from 'react-router'
import { projectPath, projectsPath } from '@/shared/api/work-projects'
import { ProjectTree } from '@/modules/work-items/projects/ProjectTree'
import { todoPath, useProjectNavigation } from '@/modules/work-items/projects/project-navigation'
import { Icon } from '@/shared/ui/icon'
import { setToken } from '@/shared/http/session'
import { isLanPreview } from '@/shared/http/lan-preview'
import { useThemeStore } from './theme'
import type { NavGroup } from './navigation'

export function AppSidebar({ groups, signedIn, onNavigate }: { groups: NavGroup[]; signedIn: boolean; onNavigate?: () => void }) {
  const { mode, palette, toggleTheme, togglePalette } = useThemeStore()
  const dark = mode === 'dark'
  const mono = palette === 'mono'
  const { projectId } = useProjectNavigation()
  const location = useLocation()
  const choosingProject = location.pathname === projectsPath
  const requestedView = choosingProject ? new URLSearchParams(location.search).get('view') : null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Link to="/work-items" aria-label="ursi-flow 首页" onClick={onNavigate} className="flex shrink-0 items-center gap-3 px-4 py-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-primary-foreground"><Icon name="workflow" size={23} /></span>
        <span><strong className="block text-[17px] font-semibold text-txt">ursi-flow</strong><span className="text-xs text-txt3">工作台</span></span>
      </Link>
      <nav aria-label="主导航" className={`scroll-area min-h-0 space-y-3 overflow-y-auto px-3 py-2 ${signedIn ? 'max-h-[56%] shrink-0 [&_.sidebar-link]:py-1.5' : 'flex-1'}`}>
        {groups.map(group => <section key={group.title}>
          <h2 className="mb-1 px-3 text-xs font-medium text-txt3">{group.title}</h2>
          {group.items.map(item => {
            const view = item.projectView
            const icon = <Icon name={item.icon} size={17} />
            if (view) {
              const base = projectId ? projectPath(projectId) : undefined
              const to = projectId ? view === 'todo' ? todoPath(projectId, location.state) : `${projectPath(projectId)}/map` : item.path
              const current = requestedView === view || (base !== undefined &&
                (location.pathname === `${base}/${view}` || (view === 'map' && location.pathname === base)))
              return <Link key={item.path} to={to} onClick={onNavigate} aria-current={current ? 'page' : undefined}
                className={current ? 'sidebar-link nav-active' : 'sidebar-link'}>{icon}{item.title}</Link>
            }
            if (item.external) return <a key={item.path} href={item.path} className="sidebar-link" referrerPolicy="no-referrer" onClick={onNavigate}>{icon}{item.title}</a>
            if (item.path === projectsPath) {
              const current = choosingProject && requestedView !== 'map' && requestedView !== 'todo'
              return <Link key={item.path} to={item.path} onClick={onNavigate} aria-current={current ? 'page' : undefined}
                className={current ? 'sidebar-link nav-active' : 'sidebar-link'}>{icon}{item.title}</Link>
            }
            return <NavLink key={item.path} to={item.path} onClick={onNavigate} className={({ isActive }) => isActive ? 'sidebar-link nav-active' : 'sidebar-link'}>{icon}{item.title}</NavLink>
          })}
        </section>)}
      </nav>
      {signedIn && <ProjectTree onNavigate={onNavigate} />}
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
