import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react'
import {
  AppWindow,
  Code2,
  Maximize,
  Minimize,
  Monitor,
  Plug,
  TerminalSquare,
  Unplug,
} from 'lucide-react'
import type { Sandbox, Source } from './data'
import { cn } from './shared/lib/utils'
import { Button } from './shared/ui/button'
import { Select } from './shared/ui/select'
import { Switch } from './shared/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './shared/ui/tabs'

const Terminal = lazy(() => import('./TerminalSurface'))
const Desktop = lazy(() => import('./DesktopSurface'))
const views = [
  ['terminal', '终端', TerminalSquare],
  ['ide', 'IDE', Code2],
  ['desktop', '桌面', Monitor],
  ['preview', '应用预览', AppWindow],
] as const

type View = (typeof views)[number][0]
type Connection = 'connecting' | 'connected' | 'failed'

export function EndpointWorkbench({
  source,
  row,
  snapshotFailed,
}: {
  source: Source
  row: Sandbox
  snapshotFailed: boolean
}) {
  const [view, setView] = useState<View>('terminal')
  const [app, setApp] = useState('')
  const [active, setActive] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [control, setControl] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [fullscreenError, setFullscreenError] = useState(false)
  const stage = useRef<HTMLElement>(null)
  const controlId = useId()
  const ready = (name: string, protocol: string) =>
    row.endpoints.some(
      (e) => e.name === name && e.protocol === protocol && e.ready,
    )
  const apps = row.endpoints.filter(
    (e) =>
      e.protocol === 'http' &&
      !['ide', 'cdp'].includes(e.name) &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(e.name),
  )
  const selected = app ? apps.find((e) => e.name === app) : apps[0]
  const sshUnavailable = !source.sshSandboxes?.includes(row.id)
    ? '未配置此实例的 Web SSH'
    : !ready('ssh', 'ssh')
      ? 'SSH 未就绪'
      : ''
  const unavailable = !source.manage
    ? '需要管理员权限'
    : snapshotFailed
      ? '无法确认实例状态'
      : row.status !== 'running' || row.operation
        ? '实例未就绪'
        : !source.capabilities.tunnel_enabled
          ? 'Gateway 隧道未启用'
          : view === 'terminal'
            ? sshUnavailable
            : !window.isSecureContext
              ? '桌面连接需要 HTTPS'
              : !ready('desktop', 'websocket')
                ? '桌面未就绪'
                : view === 'desktop'
                  ? ''
                  : sshUnavailable
                    ? sshUnavailable
                    : view === 'ide'
                      ? !ready('ide', 'http')
                        ? 'IDE 未就绪'
                        : ''
                      : !selected
                        ? '未注册应用'
                        : !selected.ready
                          ? '应用未就绪'
                          : ''
  const route = view === 'preview' ? `preview/${selected?.name}` : view
  const url = new URL(
    `./api/v1/sandboxes/${row.id}/workbench/${row.resource.generation}/${route}`,
    location.href,
  )
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const connected = active && !unavailable
  const status =
    unavailable ||
    (connected
      ? { connecting: '正在连接…', connected: '已连接', failed: '连接已关闭' }[
          connection
        ]
      : '未连接')
  const showSurface =
    connected && (connection !== 'failed' || view === 'terminal')

  useEffect(() => {
    if (unavailable) {
      setActive(false)
      setControl(false)
    }
  }, [unavailable])
  useEffect(() => {
    const sync = () =>
      setFullscreen(document.fullscreenElement === stage.current)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  function disconnect() {
    setActive(false)
    setControl(false)
  }
  function connect() {
    if (view === 'preview' && selected) setApp(selected.name)
    setAttempt((i) => i + 1)
    setConnection('connecting')
    setControl(view === 'ide')
    setActive(true)
  }
  async function toggleFullscreen() {
    setFullscreenError(false)
    try {
      if (fullscreen) await document.exitFullscreen()
      else await stage.current?.requestFullscreen()
    } catch {
      setFullscreenError(true)
    }
  }

  return (
    <section
      ref={stage}
      aria-label="端点工作台"
      className="workbench-frame min-w-0 self-start overflow-hidden rounded-lg border border-line bg-surface"
    >
      <Tabs
        value={view}
        activationMode="manual"
        onValueChange={(value) => {
          disconnect()
          setView(value as View)
        }}
        className="workbench-tabs"
      >
        <div className="flex h-12 items-center justify-between gap-1 border-b border-line px-2 sm:px-3">
          <div className="min-w-0 overflow-x-auto">
            <TabsList
              aria-label="工作台视图"
              className="min-w-max rounded-none bg-transparent p-0"
            >
              {views.map(([key, label, Icon]) => (
                <TabsTrigger
                  key={key}
                  value={key}
                  className="px-1.5 min-[360px]:px-2 data-[state=active]:bg-accent-dim data-[state=active]:text-accent-2 data-[state=active]:shadow-none sm:px-3"
                >
                  <Icon aria-hidden="true" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {document.fullscreenEnabled && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              title={fullscreen ? '退出全屏' : '全屏'}
              aria-label={fullscreen ? '退出全屏' : '全屏'}
              onClick={() => void toggleFullscreen()}
            >
              {fullscreen ? <Minimize /> : <Maximize />}
            </Button>
          )}
        </div>
        {views.map(([key, label, Icon]) => (
          <TabsContent
            key={key}
            value={key}
            className="workbench-panel min-w-0"
          >
            {key === view && (
              <>
                <div className="flex min-h-[3.25rem] flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line bg-elevated/35 px-3 py-2 sm:px-4">
                  <span
                    role="status"
                    className="inline-flex items-center gap-2 text-xs font-medium text-txt2"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'size-2 rounded-full bg-txt3',
                        connected && connection === 'connected' && 'bg-ok',
                        connected && connection === 'failed' && 'bg-err',
                        connected && connection === 'connecting' && 'bg-warn',
                      )}
                    />
                    {status}
                  </span>
                  <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
                    {view === 'preview' && apps.length > 0 && (
                      <Select
                        aria-label="已注册应用"
                        className="h-8 max-w-full px-2 py-0 text-xs"
                        value={selected?.name ?? ''}
                        onChange={(event) => {
                          disconnect()
                          setApp(event.target.value)
                        }}
                      >
                        {!selected && (
                          <option value="" disabled>
                            选择应用
                          </option>
                        )}
                        {apps.map((e) => (
                          <option key={e.name} value={e.name}>
                            {e.name} :{e.port}
                          </option>
                        ))}
                      </Select>
                    )}
                    {connected &&
                      view !== 'terminal' &&
                      connection === 'connected' && (
                        <label
                          htmlFor={controlId}
                          className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-txt2"
                        >
                          <Switch
                            id={controlId}
                            checked={control}
                            onCheckedChange={setControl}
                          />
                          键鼠控制
                        </label>
                      )}
                    {connected && connection !== 'failed' ? (
                      <Button size="sm" variant="outline" onClick={disconnect}>
                        <Unplug />
                        断开
                      </Button>
                    ) : (
                      !unavailable && (
                        <Button size="sm" variant="primary" onClick={connect}>
                          <Plug />
                          {connected ? '重新连接' : '连接'}
                        </Button>
                      )
                    )}
                  </div>
                </div>
                {fullscreenError && (
                  <p role="alert" className="px-4 py-2 text-sm text-err">
                    无法进入全屏
                  </p>
                )}
                <div
                  className={cn(
                    'workbench-screen',
                    view !== 'terminal' && 'workbench-screen-graphical',
                  )}
                >
                  {showSurface ? (
                    <Suspense
                      key={attempt}
                      fallback={
                        <div className="stage-idle">正在加载{label}…</div>
                      }
                    >
                      {view === 'terminal' ? (
                        <Terminal url={url.href} status={setConnection} />
                      ) : (
                        <Desktop
                          url={url.href}
                          control={control}
                          status={setConnection}
                        />
                      )}
                    </Suspense>
                  ) : (
                    <div className="stage-idle">
                      <Icon
                        aria-hidden="true"
                        className="size-7 text-neutral-500"
                      />
                      <span>
                        {unavailable ||
                          (connection === 'failed' && active
                            ? '连接已关闭'
                            : `${label}未连接`)}
                      </span>
                    </div>
                  )}
                </div>
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </section>
  )
}
