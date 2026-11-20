import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CircleAlert, History, RefreshCw, Server, Settings2, Workflow } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert'
import { Badge } from './components/ui/badge'
import { Button, buttonVariants } from './components/ui/button'
import { Empty, EmptyContent, EmptyMedia, EmptyTitle } from './components/ui/empty'
import { HashRouter, NavLink, Route, Routes } from 'react-router'
import { Flows, FlowEditor } from './Flows'
import { RunDetail, Runs } from './Runs'
import { Config } from './Config'
import { ApiError, loadSource, type Source } from './data'
import { initAppearance } from './theme'
import { cn } from './lib/utils'
import './tokens.css'
import './style.css'

type State<T> = { value?: T; loading?: boolean; error?: string }
export type Loaded<T> = State<T> & { refresh: () => void }
/** 读取资源并保留最后一次结果；刷新失败时仍显示旧数据。 */
export function useLoad<T>(
  load: (signal: AbortSignal) => Promise<T> | T,
  deps: React.DependencyList,
): Loaded<T> {
  const [seq, refresh] = React.useReducer((n) => n + 1, 0)
  const [state, set] = useState<State<T>>({ loading: true })
  useEffect(() => {
    const ctl = new AbortController()
    set((previous) => ({ ...previous, loading: true, error: undefined }))
    Promise.resolve()
      .then(() => load(ctl.signal))
      .then(
        (value) => {
          if (!ctl.signal.aborted) set({ value })
        },
        (e) => {
          if (!ctl.signal.aborted)
            set((previous) => ({ ...previous, loading: false, error: message(e) }))
        },
      )
    return () => ctl.abort()
  }, [...deps, seq])
  return { ...state, refresh }
}
export function message(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message
  return '操作未完成，请稍后重试。'
}
export function AsyncState({ state }: { state: Loaded<unknown> }) {
  if (state.error)
    return (
      <Alert variant="error">
        <CircleAlert />
        <AlertDescription role="status">{state.error}</AlertDescription>
        <Button size="sm" onClick={state.refresh}>
          重试
        </Button>
      </Alert>
    )
  return (
    <Empty role="status">
      <EmptyMedia>
        <RefreshCw className="animate-spin" />
      </EmptyMedia>
      <EmptyTitle>正在读取…</EmptyTitle>
    </Empty>
  )
}
/** 页面标题栏：标题、说明与右侧操作。 */
export function PageHeading({
  title,
  description,
  actions,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="mb-5 flex min-w-0 flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
export function Refresh({ state }: { state: Loaded<unknown> }) {
  return (
    <Button onClick={state.refresh} disabled={state.loading}>
      <RefreshCw />
      刷新
    </Button>
  )
}
/** 状态的中文名；排序与筛选都按它匹配，读起来才和界面一致。 */
export const statusLabel = (status: string) => statusLabels[status] || status
const statusLabels: Record<string, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  stopped: '已停止',
  unknown: '状态未知',
}
const statusVariants: Record<string, 'info' | 'ok' | 'err' | 'warn' | 'default'> = {
  running: 'info',
  completed: 'ok',
  failed: 'err',
  interrupted: 'warn',
  stopped: 'warn',
  unknown: 'warn',
}
export function Status({ status }: { status: string }) {
  return (
    <Badge variant={statusVariants[status] ?? 'default'} data-status={status}>
      <i className="size-1.5 rounded-full bg-current" />
      {statusLabels[status] || status}
    </Badge>
  )
}
function Mode({ source }: { source?: Source }) {
  if (!source) return null
  return (
    <span className="ml-auto flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
      <Server className="size-3.5 shrink-0" />
      {source.workspace ? `Runtime · ${source.workspace.path}` : '本地 Runtime'}
    </span>
  )
}
function Header({ source }: { source?: Source }) {
  return (
    <header className="border-b border-border bg-card">
      <div className="bar">
        <span className="flex min-w-0 items-center gap-2 font-semibold">
          <span className="inline-grid size-8 shrink-0 place-items-center rounded-lg bg-accent-dim text-accent-2">
            <Workflow className="size-[22px]" />
          </span>
          Ursi Flow
        </span>
        <nav aria-label="主导航" className="flex min-w-0 flex-wrap items-center gap-1">
          {[
            { to: '/flows', icon: Workflow, label: 'Flow 包' },
            { to: '/runs', icon: History, label: '运行记录' },
            { to: '/flow-config', icon: Settings2, label: '运行配置' },
          ].map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(buttonVariants({ variant: 'ghost', size: 'sm' }), isActive && 'bg-accent-dim text-accent-2')
              }
            >
              <Icon />
              {label}
            </NavLink>
          ))}
        </nav>
        <Mode source={source} />
      </div>
    </header>
  )
}
function Pages({ source }: { source: Source }) {
  return (
    <Routes>
      <Route index element={<Flows source={source} />} />
      <Route path="flows" element={<Flows source={source} />} />
      <Route path="flows/new" element={<FlowEditor source={source} />} />
      <Route path="flows/:id/edit" element={<FlowEditor source={source} />} />
      <Route path="runs" element={<Runs source={source} />} />
      <Route path="runs/:id" element={<RunDetail source={source} />} />
      <Route path="flow-config" element={<Config source={source} />} />
      <Route
        path="*"
        element={
          <main>
            <p>页面不存在。</p>
            <NavLink className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'mt-3')} to="/flows">
              返回 Flow 包
            </NavLink>
          </main>
        }
      />
    </Routes>
  )
}
function App() {
  const config = useLoad(loadSource, [])
  return (
    <>
      <Header source={config.value} />
      {config.value ? (
        <Pages source={config.value} />
      ) : (
        <main>
          <AsyncState state={config} />
        </main>
      )}
    </>
  )
}
initAppearance()
createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <App />
  </HashRouter>,
)
