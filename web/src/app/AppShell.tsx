import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Link, Outlet, useLocation, useMatches } from 'react-router'

import { readToken, setToken, subscribeSession } from '@/shared/http/session'
import { useFeedbackStore } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { Modal } from '@/shared/ui/modal'
import { Sheet, SheetContent } from '@/shared/ui/sheet'
import { ShellSidebar } from '@/shared/ui/shell-sidebar'
import { cn } from '@/shared/lib/utils'
import { navigationGroups } from './router'
import { useThemeStore } from './theme'


function routeTitle(matches: { handle?: unknown }[]): string | undefined {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const handle = matches[index]?.handle as { title?: string } | undefined
    if (handle?.title) return handle.title
  }
  return undefined
}

export default function AppShell() {
  const location = useLocation()
  const signedIn = Boolean(useSyncExternalStore(subscribeSession, readToken))
  const matches = useMatches()
  const themeMode = useThemeStore((state) => state.mode)
  const palette = useThemeStore((state) => state.palette)
  const toggleTheme = useThemeStore((state) => state.toggleTheme)
  const togglePalette = useThemeStore((state) => state.togglePalette)
  const toasts = useFeedbackStore((state) => state.toasts)
  const dismissToast = useFeedbackStore((state) => state.dismissToast)
  const confirmation = useFeedbackStore((state) => state.confirmation)
  const finishConfirmation = useFeedbackStore((state) => state.finishConfirmation)

  const [drawerPath, setDrawerPath] = useState<string | null>(null)
  const drawerOpen = drawerPath !== null && drawerPath === location.pathname

  const currentDomain = navigationGroups
    .flatMap((group) => group.items)
    .find((item) => location.pathname === item.path || location.pathname.startsWith(`${item.path}/`))
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
          <ShellSidebar groups={navigationGroups} mode={themeMode} palette={palette} signedIn={signedIn} onToggleMode={toggleTheme} onTogglePalette={togglePalette} onLogout={() => { setToken(''); closeDrawer() }} />
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
          <ShellSidebar groups={navigationGroups} mode={themeMode} palette={palette} signedIn={signedIn} onNavigate={closeDrawer} onToggleMode={toggleTheme} onTogglePalette={togglePalette} onLogout={() => { setToken(''); closeDrawer() }} />
        </SheetContent>
      </Sheet>


      <Modal
        open={Boolean(confirmation)}
        title={confirmation?.title}
        width={440}
        onClose={() => { finishConfirmation(false) }}
        footer={(
          <>
            <Button autoFocus onClick={() => { finishConfirmation(false) }}>取消</Button>
            <Button variant={confirmation?.danger ? 'danger' : 'primary'} onClick={() => { finishConfirmation(true) }}>
              {confirmation?.confirmLabel || '确认'}
            </Button>
          </>
        )}
      >
        <p className="text-sm leading-7 text-txt2">{confirmation?.description}</p>
      </Modal>

      <div className="toast-region" aria-live="polite" aria-relevant="additions" aria-label="操作通知">
        {toasts.map((toast) => (
          <div key={toast.id} className={cn('toast-item', toast.kind === 'error' ? 'border-err/30' : 'border-line')}>
            <Icon name={toast.kind === 'error' ? 'warning' : 'check'} className={toast.kind === 'error' ? 'text-err' : 'text-ok'} />
            <p className="min-w-0 flex-1 break-words text-sm text-txt">{toast.message}</p>
            <button type="button" className="icon-button h-7 w-7" aria-label="关闭通知" onClick={() => { dismissToast(toast.id) }}>
              <Icon name="close" size={15} />
            </button>
          </div>
        ))}
      </div>
    </>
  )
}
