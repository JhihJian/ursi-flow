import { lazy, Suspense, useState } from 'react'
import { AppWindow, Code2, Monitor, Plug, TerminalSquare, Unplug } from 'lucide-react'
import type { Sandbox, Source } from './data'
import { Button } from './shared/ui/button'

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

export function EndpointWorkbench({ source, row }: { source: Source; row: Sandbox }) {
  const [view, setView] = useState<View>('terminal')
  const [app, setApp] = useState('')
  const [active, setActive] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [control, setControl] = useState(false)
  const ready = (name: string, protocol: string) =>
    row.endpoints.some((e) => e.name === name && e.protocol === protocol && e.ready)
  const apps = row.endpoints.filter((e) => e.protocol === 'http' && !['ide', 'cdp'].includes(e.name) && /^[a-zA-Z0-9_-]{1,64}$/.test(e.name))
  const selected = apps.find((e) => e.name === app) || apps[0]
  const sshUnavailable = !source.sshSandboxes?.includes(row.id) ? '未配置此实例的 Web SSH' : !ready('ssh', 'ssh') ? 'SSH 未就绪' : ''
  const unavailable = source.demo ? '演示数据' : !source.manage ? '需要管理员权限' :
    row.status !== 'running' || row.operation ? '实例未就绪' :
    !source.capabilities.tunnel_enabled ? 'Gateway 隧道未启用' :
    view === 'terminal' ? sshUnavailable :
    !window.isSecureContext ? '桌面连接需要 HTTPS' :
    !ready('desktop', 'websocket') ? '桌面未就绪' :
    view === 'desktop' ? '' : sshUnavailable ? sshUnavailable :
    view === 'ide' ? !ready('ide', 'http') ? 'IDE 未就绪' : '' :
    !selected ? '未注册应用' : !selected.ready ? '应用未就绪' : ''
  const route = view === 'preview' ? `preview/${selected?.name}` : view
  const url = new URL(`./api/v1/sandboxes/${row.id}/workbench/${row.resource.generation}/${route}`, location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const connected = active && !unavailable
  const demoTerminal = source.demo && view === 'terminal' && active
  const status = unavailable || (connected ? { connecting: '正在连接…', connected: '已连接', failed: '连接已关闭' }[connection] : '未连接')

  function disconnect() {
    setActive(false)
    setControl(false)
  }
  function connect() {
    setAttempt((i) => i + 1)
    setConnection('connecting')
    setControl(view === 'ide')
    setActive(true)
  }

  return (
    <section aria-label="端点工作台">
      <h2>端点工作台</h2>
      <div className="flex flex-wrap gap-1 border-b border-line pb-2" aria-label="工作台视图" role="group">
        {views.map(([key, label, Icon]) => (
          <Button key={key} aria-pressed={view === key} variant={view === key ? 'default' : 'ghost'} onClick={() => {
            if (view === key) return
            disconnect()
            setView(key)
          }}>
            <Icon />{label}
          </Button>
        ))}
      </div>
      <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 py-2">
        {view === 'preview' && apps.length > 0 && (
          <select aria-label="已注册应用" className="max-w-full rounded border border-line bg-panel px-2 py-1 text-sm" value={selected?.name} onChange={(event) => {
            disconnect()
            setApp(event.target.value)
          }}>
            {apps.map((e) => <option key={e.name} value={e.name}>{e.name} :{e.port}</option>)}
          </select>
        )}
        <span role="status" className="text-sm text-txt2">{status}</span>
        {(connected || demoTerminal) && connection !== 'failed' ? (
          <Button size="sm" variant="outline" onClick={disconnect}><Unplug />断开</Button>
        ) : (!unavailable || (source.demo && view === 'terminal')) && (
          <Button size="sm" variant="outline" onClick={connect}>
            <Plug />{source.demo ? '打开终端示例' : connection === 'failed' && active ? '重新连接' : '连接'}
          </Button>
        )}
        {connected && view !== 'terminal' && connection === 'connected' && (
          <label className="inline-flex items-center gap-2 text-sm text-txt2">
            <input type="checkbox" checked={control} onChange={(event) => setControl(event.target.checked)} />键鼠控制
          </label>
        )}
      </div>
      {(connected || demoTerminal) && (
        <Suspense key={attempt} fallback={<p role="status" className="text-sm text-txt2">加载组件…</p>}>
          {view === 'terminal' ? <Terminal url={source.demo ? undefined : url.href} status={setConnection} /> :
            <Desktop url={url.href} control={control} status={setConnection} />}
        </Suspense>
      )}
    </section>
  )
}
