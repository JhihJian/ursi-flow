import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type DependencyList,
  type ReactNode,
} from 'react'
import { CircleAlert, RefreshCw } from 'lucide-react'
import { useLocation } from 'react-router'
import { Badge } from './shared/ui/badge'
import { Button } from './shared/ui/button'
import { cn } from './shared/lib/utils'
import { GatewayError, loadSource, type Sandbox, type Source } from './data'

/** 沙箱控制台的公共数据层与小组件：独立部署与嵌入外壳共用。 */

export const statuses: Record<string, string> = {
  running: '运行中',
  preparing: '准备中',
  stopped: '已停止',
  deleting: '删除中',
  error: '异常',
}

export const nameOf = (row: Sandbox) => row.spec.labels.name || row.id

export const memory = (mb: number) =>
  mb % 1024 === 0 ? `${mb / 1024} GiB` : `${mb} MiB`

export type State<T> = { value?: T; loading?: boolean; error?: string }
export type RequestState = State<unknown> & { refresh: () => void }

export function useLoad<T>(
  load: (signal: AbortSignal) => T | Promise<T>,
  deps: DependencyList,
) {
  const [seq, refresh] = useReducer((n) => n + 1, 0)
  const run = useRef(0)
  const [state, set] = useState<State<T>>({ loading: true })
  useEffect(() => {
    const controller = new AbortController()
    const current = ++run.current
    set((previous) => ({ value: previous.value, loading: true }))
    Promise.resolve()
      .then(() => load(controller.signal))
      .then(
        (value) => {
          if (!controller.signal.aborted && current === run.current) set({ value })
        },
        (error) => {
          if (controller.signal.aborted || current !== run.current) return
          const lost =
            error instanceof GatewayError && [401, 403, 404].includes(error.status)
          set((previous) => ({
            value: lost ? undefined : previous.value,
            error: error.message,
          }))
        },
      )
    return () => controller.abort()
  }, [...deps, seq])
  function update(value: T) {
    // 生命周期操作返回的新状态优先于尚未完成的旧详情请求。
    run.current += 1
    set({ value })
  }
  return { ...state, refresh, update }
}

export function AsyncState({ state }: { state: RequestState }) {
  return (
    <div role="status" className="sbx-empty-state">
      {state.error ? (
        <>
          <CircleAlert className="size-4 text-sbx-err" />
          {state.error}
          <Button variant="outline" size="sm" onClick={state.refresh}>
            <RefreshCw />
            重试
          </Button>
        </>
      ) : (
        '正在读取…'
      )}
    </div>
  )
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'running'
      ? 'bg-sbx-ok/10 text-sbx-ok'
      : status === 'error'
        ? 'bg-sbx-err/10 text-sbx-err'
        : ['preparing', 'deleting'].includes(status)
          ? 'bg-sbx-warn/10 text-sbx-warn'
          : 'bg-sbx-elevated text-sbx-txt3'
  return (
    <Badge
      variant="secondary"
      data-testid="instance-status"
      className={cn('gap-1.5 whitespace-nowrap', tone)}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {statuses[status] || status}
    </Badge>
  )
}

export function Refresh({ state }: { state: RequestState }) {
  return (
    <Button
      variant="outline"
      onClick={state.refresh}
      disabled={state.loading}
      aria-busy={state.loading}
    >
      <RefreshCw className={cn(state.loading && 'motion-safe:animate-spin')} />
      刷新
    </Button>
  )
}

export interface SandboxData {
  config: ReturnType<typeof useLoad<Source>>
  list: ReturnType<typeof useLoad<Sandbox[]>>
  status: string
  setStatus: (value: string) => void
}

const DataContext = createContext<SandboxData | null>(null)

/**
 * 配置、实例列表与筛选状态：侧边栏和工作区共用一份，避免两边各发一轮请求。
 * 必须在 router 内使用；路由变化时刷新列表。
 */
export function SandboxDataProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const config = useLoad(loadSource, [])
  const source = config.value
  const list = useLoad(
    // 配置就绪前不发请求，避免先写入空列表把错误态和空态混在一起。
    (signal) => (source ? source.list(signal) : new Promise<Sandbox[]>(() => {})),
    [source, pathname],
  )
  const [status, setStatus] = useState('')
  // 配置未就绪时把配置错误接到列表上：侧边栏只有一处状态，不出现两个互相矛盾的提示。
  const listState = useMemo(() => {
    if (source || !config.error) return list
    return { ...list, value: undefined, loading: false, error: config.error, refresh: config.refresh }
  }, [config, list, source])
  const value = useMemo<SandboxData>(
    () => ({ config, list: listState, status, setStatus }),
    [config, listState, status],
  )
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useSandboxData(): SandboxData {
  const value = useContext(DataContext)
  if (!value) throw new Error('沙箱：缺少 SandboxDataProvider')
  return value
}
