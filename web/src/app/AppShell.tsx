import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Outlet, useLocation, useMatches } from 'react-router'

import { api, errorMessage } from '@/shared/api'
import { useFeedbackStore } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/modal'
import { ResourceState } from '@/shared/ui/resource-state'
import { Sheet, SheetContent } from '@/shared/ui/sheet'
import { ShellSidebar } from '@/shared/ui/shell-sidebar'
import { Switch } from '@/shared/ui/switch'
import { cn } from '@/shared/lib/utils'
import { navigationGroups } from './router'
import { useThemeStore } from './theme'

interface DemoSettings {
  delay: number
  failNext: boolean
}

function routeTitle(matches: { handle?: unknown }[]): string | undefined {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const handle = matches[index]?.handle as { title?: string } | undefined
    if (handle?.title) return handle.title
  }
  return undefined
}

export default function AppShell() {
  const location = useLocation()
  const matches = useMatches()
  const isDemo = import.meta.env.VITE_API_MODE !== 'live'
  const themeMode = useThemeStore((state) => state.mode)
  const palette = useThemeStore((state) => state.palette)
  const toggleTheme = useThemeStore((state) => state.toggleTheme)
  const togglePalette = useThemeStore((state) => state.togglePalette)
  const toasts = useFeedbackStore((state) => state.toasts)
  const dismissToast = useFeedbackStore((state) => state.dismissToast)
  const confirmation = useFeedbackStore((state) => state.confirmation)
  const notify = useFeedbackStore((state) => state.notify)
  const confirmAction = useFeedbackStore((state) => state.confirmAction)
  const finishConfirmation = useFeedbackStore((state) => state.finishConfirmation)

  const [drawerPath, setDrawerPath] = useState<string | null>(null)
  const drawerOpen = drawerPath !== null && drawerPath === location.pathname
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [settings, setSettings] = useState<DemoSettings>({ delay: 0, failNext: false })

  const currentDomain = navigationGroups
    .flatMap((group) => group.items)
    .find((item) => location.pathname === item.path || location.pathname.startsWith(`${item.path}/`))
  // 页面标题优先取路由 handle.title，未声明时退回当前导航项标题。
  const pageTitle = useMemo(() => routeTitle(matches) ?? currentDomain?.title ?? '工作台', [matches, currentDomain])

  useEffect(() => { document.title = `${pageTitle} · ursi-flow` }, [pageTitle])

  const closeDrawer = useCallback(() => { setDrawerPath(null) }, [])
  const openDrawer = useCallback(() => { setDrawerPath(location.pathname) }, [location.pathname])
  const changeDrawer = useCallback((open: boolean) => { setDrawerPath(open ? location.pathname : null) }, [location.pathname])

  async function loadSettings() {
    setSettingsLoading(true)
    setSettingsReady(false)
    setSettingsError('')
    try {
      setSettings(await api.get<DemoSettings>('/demo/settings'))
      setSettingsReady(true)
    } catch (error) {
      setSettingsError(errorMessage(error))
    } finally {
      setSettingsLoading(false)
    }
  }

  function openSettings() {
    setDrawerPath(null)
    setSettingsOpen(true)
    void loadSettings()
  }

  async function saveSettings() {
    if (!Number.isFinite(settings.delay) || settings.delay < 0 || settings.delay > 30000) {
      setSettingsError('请求延迟需在 0 到 30000 毫秒之间。')
      return
    }
    setSettingsSaving(true)
    setSettingsError('')
    try {
      await api.put<DemoSettings>('/demo/settings', { delay: Math.round(settings.delay), failNext: settings.failNext })
      setSettingsOpen(false)
      notify('演示设置已保存')
    } catch (error) {
      setSettingsError(errorMessage(error))
    } finally {
      setSettingsSaving(false)
    }
  }

  async function resetDemo() {
    const accepted = await confirmAction({
      title: '重置演示数据？',
      description: '将清除本地修改与运行记录，恢复初始演示数据，并重新加载页面。',
      danger: true,
      confirmLabel: '重置演示',
    })
    if (!accepted) return
    setSettingsSaving(true)
    try {
      await api.post('/demo/reset')
      window.location.reload()
    } catch (error) {
      setSettingsError(errorMessage(error))
    } finally {
      setSettingsSaving(false)
    }
  }

  return (
    <>
      <a href="#main-content" className="skip-link">跳到主要内容</a>
      <div className="app-shell">
        <aside className="desktop-sidebar">
          <ShellSidebar groups={navigationGroups} mode={themeMode} palette={palette} demo={isDemo} onToggleMode={toggleTheme} onTogglePalette={togglePalette} onSettings={openSettings} />
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
          <ShellSidebar groups={navigationGroups} mode={themeMode} palette={palette} demo={isDemo} onNavigate={closeDrawer} onToggleMode={toggleTheme} onTogglePalette={togglePalette} onSettings={openSettings} />
        </SheetContent>
      </Sheet>

      <Modal
        open={settingsOpen && isDemo}
        title="演示模式设置"
        width={480}
        onClose={() => { setSettingsOpen(false) }}
        footer={(
          <>
            <Button onClick={() => { setSettingsOpen(false) }}>取消</Button>
            <Button
              type="submit"
              form="demo-settings"
              variant="primary"
              loading={settingsSaving}
              disabled={settingsLoading || !settingsReady}
            >
              保存设置
            </Button>
          </>
        )}
      >
        <ResourceState loading={settingsLoading} error={!settingsReady && settingsError ? settingsError : undefined} onRetry={() => { void loadSettings() }} />
        {settingsReady && !settingsLoading ? (
          <form
            id="demo-settings"
            className="space-y-6"
            onSubmit={(event) => { event.preventDefault(); void saveSettings() }}
          >
            <p className="text-sm leading-6 text-txt3">调整请求速度与失败场景，体验应用的加载、重试和恢复流程。数据仅保存在当前浏览器。</p>
            <label className="field">
              <span className="field-label">请求延迟 <span className="font-normal text-txt3">（毫秒）</span></span>
              <Input
                type="number"
                min={0}
                max={30000}
                step={100}
                value={Number.isNaN(settings.delay) ? '' : settings.delay}
                disabled={settingsSaving}
                onChange={(event) => { setSettings({ ...settings, delay: event.target.valueAsNumber }) }}
              />
              <span className="text-xs text-txt3">设为 0 可立即响应，最大 30000 毫秒。</span>
            </label>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-line p-4">
              <div>
                <label id="fail-next-label" className="text-sm font-medium text-txt">让下一次请求失败</label>
                <p className="mt-1 text-xs text-txt3">保存后，下一个业务请求将返回模拟错误。</p>
              </div>
              <Switch
                aria-labelledby="fail-next-label"
                disabled={settingsSaving}
                checked={settings.failNext}
                onCheckedChange={(checked) => { setSettings({ ...settings, failNext: checked }) }}
              />
            </div>
            {settingsError ? <p role="alert" className="text-sm text-err">{settingsError}</p> : null}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
              <div>
                <p className="text-sm font-medium text-txt">恢复初始数据</p>
                <p className="mt-1 text-xs text-txt3">清除当前浏览器中的演示修改。</p>
              </div>
              <Button variant="danger" icon="refresh" disabled={settingsSaving} onClick={() => { void resetDemo() }}>重置演示</Button>
            </div>
          </form>
        ) : null}
      </Modal>

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
