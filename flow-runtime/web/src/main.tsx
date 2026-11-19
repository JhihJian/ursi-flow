import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { CircleAlert, History, RefreshCw, Server, Settings2, Workflow } from 'lucide-react'
import { HashRouter, NavLink, Route, Routes } from 'react-router'
import { Flows, FlowEditor } from './Flows'
import { RunDetail, Runs } from './Runs'
import { Config } from './Config'
import {
  ApiError,
  loadSource,
  readToken,
  setToken,
  subscribeSession,
  type Source,
} from './data'
import { initAppearance } from './theme'
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
  return (
    <div role="status" className="empty">
      {state.error ? (
        <>
          <CircleAlert />
          {state.error}
          <button onClick={state.refresh}>重试</button>
        </>
      ) : (
        '正在读取…'
      )}
    </div>
  )
}
export function Refresh({ state }: { state: Loaded<unknown> }) {
  return (
    <button onClick={state.refresh} disabled={state.loading}>
      <RefreshCw />
      刷新
    </button>
  )
}
const statusLabels: Record<string, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  stopped: '已停止',
  unknown: '状态未知',
}
export function Status({ status }: { status: string }) {
  return (
    <span className={'badge ' + status}>
      <i />
      {statusLabels[status] || status}
    </span>
  )
}
function Mode({ source }: { source?: Source }) {
  if (!source) return null
  return (
    <span className="mode">
      <Server size={14} />
      {source.mode === 'demo'
        ? '演示数据'
        : source.workspace
          ? `Runtime · ${source.workspace.path}`
          : '本地 Runtime'}
    </span>
  )
}
function Header({ source }: { source?: Source }) {
  return (
    <header>
      <div className="bar">
        <span className="brand">
          <span className="logo">
            <Workflow size={22} />
          </span>
          Ursi Flow
        </span>
        <nav aria-label="主导航">
          <NavLink to="/flows">
            <Workflow size={16} />
            Flow 包
          </NavLink>
          <NavLink to="/runs">
            <History size={16} />
            运行记录
          </NavLink>
          <NavLink to="/flow-config">
            <Settings2 size={16} />
            运行配置
          </NavLink>
        </nav>
        <Mode source={source} />
      </div>
    </header>
  )
}
function TokenForm({ invalid }: { invalid: boolean }) {
  const [value, set] = useState('')
  return (
    <main>
      <form
        className="panel max-w-md space-y-4 p-6"
        onSubmit={(event) => {
          event.preventDefault()
          setToken(value)
        }}
      >
        <h1>连接 Runtime</h1>
        <p className="muted">
          请输入控制台访问令牌。令牌只保存在此标签页的会话中。
        </p>
        {invalid && (
          <p role="alert" className="warning">
            令牌无效或已过期，请重新输入。
          </p>
        )}
        <label className="block">
          访问令牌
          <input
            className="input mt-2"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(event) => set(event.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={!value.trim()}>
          连接
        </button>
      </form>
    </main>
  )
}
function Gate({ source }: { source: Source }) {
  const token = useSyncExternalStore(subscribeSession, readToken)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    // 收到 401 时数据层会清空令牌，这里记录需要提醒重新输入。
    const onSession = () => setInvalid(!readToken())
    window.addEventListener('ursi-flow:session', onSession)
    return () => window.removeEventListener('ursi-flow:session', onSession)
  }, [])
  useEffect(() => {
    if (token) setInvalid(false)
  }, [token])
  if (source.auth && !token) return <TokenForm invalid={invalid} />
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
            页面不存在
            <NavLink className="back" to="/flows">
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
        <Gate source={config.value} />
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
