import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Link, Outlet, useLocation, useMatches } from 'react-router'

import { readToken, subscribeSession } from '@/shared/http/session'
import { isLanPreview } from '@/shared/http/lan-preview'
import { FeedbackHost } from './FeedbackHost'
import { Icon } from '@/shared/ui/icon'
import { Sheet, SheetContent } from '@/shared/ui/sheet'
import { AppSidebar } from './AppSidebar'
import { deployedNavigation, navigationGroups } from './navigation'


function routeTitle(matches: { handle?: unknown }[]): string | undefined {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const handle = matches[index]?.handle as { title?: string } | undefined
    if (handle?.title) return handle.title
  }
  return undefined
}

const readAppSession = () => isLanPreview() ? 'lan-preview' : readToken()

export default function AppShell() {
  const session = useSyncExternalStore(subscribeSession, readAppSession)
  const signedIn = Boolean(session)
  return <Workspace key={session} signedIn={signedIn} />
}

function Workspace({ signedIn }: { signedIn: boolean }) {
  const location = useLocation()
  const matches = useMatches()
  const groups = deployedNavigation().map(group => ({ ...group,
    items: group.items.filter(item => !isLanPreview() || item.lanPreview),
  })).filter(group => group.items.length > 0)

  const [drawerPath, setDrawerPath] = useState<string | null>(null)
  const drawerOpen = drawerPath !== null && drawerPath === location.pathname

  const currentDomain = navigationGroups
    .flatMap((group) => group.items)
    .find(item => item.routeId ? matches.some(match => match.id === item.routeId)
      : location.pathname === item.path || location.pathname.startsWith(`${item.path}/`))
  // 页面标题优先取路由 handle.title，未声明时退回当前导航项标题。
  const pageTitle = useMemo(() => routeTitle(matches) ?? currentDomain?.title ?? '工作台', [matches, currentDomain])

  useEffect(() => { document.title = `${pageTitle} · ursi-flow` }, [pageTitle])

  const closeDrawer = useCallback(() => { setDrawerPath(null) }, [])
  const openDrawer = useCallback(() => { setDrawerPath(location.pathname) }, [location.pathname])
  const changeDrawer = useCallback((open: boolean) => { setDrawerPath(open ? location.pathname : null) }, [location.pathname])

  return (
    <>
      <a href="#main-content" className="skip-link">跳到主要内容</a>
      <div className="app-shell">
        <aside className="desktop-sidebar">
          <AppSidebar groups={groups} signedIn={signedIn} activePath={currentDomain?.path} />
        </aside>
        <div className="shell-col">
          <header className="shell-topbar">
            <button
              type="button"
              className="icon-button -ml-2"
              aria-label="打开导航菜单"
              aria-expanded={drawerOpen}
              aria-haspopup="dialog"
              onClick={openDrawer}
            >
              <Icon name="menu" size={21} />
            </button>
            <nav aria-label="面包屑" className="flex min-w-0 items-center gap-2 text-sm">
              {currentDomain && location.pathname !== currentDomain.path ? (
                <>
                  <Link to={currentDomain.path} className="shrink-0 text-txt3 hover:text-txt">{currentDomain.title}</Link>
                  <Icon name="chevron-right" size={13} className="text-txt3" />
                </>
              ) : null}
              <span aria-current="page" className="truncate font-medium text-txt">{pageTitle}</span>
            </nav>
          </header>
          <div className="shell-scroll">
            <main id="main-content" tabIndex={-1} className="shell-content">
              <Outlet />
            </main>
          </div>
        </div>
      </div>

      <Sheet open={drawerOpen} onOpenChange={changeDrawer}>
        <SheetContent side="left" title="工作区导航" className="w-[280px] border-r border-line sm:max-w-[280px]">
          <AppSidebar groups={groups} signedIn={signedIn} activePath={currentDomain?.path} onNavigate={closeDrawer} />
        </SheetContent>
      </Sheet>


      <FeedbackHost />
    </>
  )
}
