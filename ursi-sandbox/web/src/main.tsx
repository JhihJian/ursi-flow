import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type DependencyList,
} from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity,
  ArrowLeft,
  Box,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Layers3,
  RefreshCw,
  Server,
} from 'lucide-react'
import {
  HashRouter,
  Link,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useMatch,
  useOutletContext,
  useParams,
  useNavigate,
} from 'react-router'
import { ObservationRoute } from './ObservationPage'
import { EndpointWorkbench } from './Workbench'
import { CreateSandbox, Actions, CliTools } from './Management'
import { AccessSetup } from './AccessSetup'
import { CapabilityRegistry } from './CapabilityRegistry'
import { Button, buttonVariants } from './shared/ui/button'
import { Badge } from './shared/ui/badge'
import { Alert } from './shared/ui/alert'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './shared/ui/collapsible'
import { cn } from './shared/lib/utils'
import { loadSource, GatewayError, type Source, type Sandbox } from './data'
import './tokens.css'
import './style.css'

const statuses: Record<string, string> = {
  running: '运行中',
  preparing: '准备中',
  stopped: '已停止',
  deleting: '删除中',
  error: '异常',
}
const nameOf = (r: Sandbox) => r.spec.labels.name || r.id
const memory = (mb: number) =>
  mb % 1024 === 0 ? `${mb / 1024} GiB` : `${mb} MiB`
type State<T> = { value?: T; loading?: boolean; error?: string }
function useLoad<T>(
  load: (s: AbortSignal) => T | Promise<T>,
  deps: DependencyList,
) {
  const [seq, refresh] = useReducer((n) => n + 1, 0)
  const run = useRef(0)
  const [state, set] = useState<State<T>>({ loading: true })
  useEffect(() => {
    const ctl = new AbortController(),
      current = ++run.current
    set((previous) => ({ value: previous.value, loading: true }))
    Promise.resolve()
      .then(() => load(ctl.signal))
      .then(
        (value) => {
          if (!ctl.signal.aborted && current === run.current) set({ value })
        },
        (error) => {
          if (ctl.signal.aborted || current !== run.current) return
          const lost =
            error instanceof GatewayError &&
            [401, 403, 404].includes(error.status)
          set((previous) => ({
            value: lost ? undefined : previous.value,
            error: error.message,
          }))
        },
      )
    return () => ctl.abort()
  }, [...deps, seq])
  function update(value: T) {
    // 生命周期操作返回的新状态优先于尚未完成的旧详情请求。
    run.current += 1
    set({ value })
  }
  return { ...state, refresh, update }
}
type RequestState = State<unknown> & { refresh: () => void }
function AsyncState({ state }: { state: RequestState }) {
  return (
    <div role="status" className="empty-state">
      {state.error ? (
        <>
          <CircleAlert className="size-4 text-err" />
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
function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'running'
      ? 'bg-ok/10 text-ok'
      : status === 'error'
        ? 'bg-err/10 text-err'
        : ['preparing', 'deleting'].includes(status)
          ? 'bg-warn/10 text-warn'
          : 'bg-elevated text-txt3'
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
function Refresh({ state }: { state: RequestState }) {
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
function Header({ source }: { source?: Source }) {
  return (
    <header className="border-b border-line bg-surface">
      <div className="page-shell flex min-h-14 flex-wrap items-center gap-x-5 gap-y-1">
        <Link
          className="inline-flex min-h-12 items-center gap-2 whitespace-nowrap font-semibold"
          to="/sandboxes"
        >
          <span className="icon-tile size-7">
            <Boxes className="size-4" />
          </span>
          Ursi Sandbox
        </Link>
        <nav
          className="order-last flex w-full items-center gap-4 sm:order-none sm:w-auto"
          aria-label="主导航"
        >
          <NavLink className="nav-link" to="/sandboxes">
            沙箱
          </NavLink>
          {source && (
            <NavLink className="nav-link" to="/registry">
              能力注册表
            </NavLink>
          )}
          {source?.manage && source.capabilities.access_keys && (
            <NavLink className="nav-link" to="/access">
              接入配置
            </NavLink>
          )}
        </nav>
        <Badge variant="outline" className="ml-auto whitespace-nowrap">
          <Server className="size-3" />
          {source?.manage
            ? 'Gateway · 管理员'
            : source
              ? 'Gateway · 只读'
              : 'Gateway'}
        </Badge>
      </div>
    </header>
  )
}
const filters = [
  ['', '全部实例', Layers3],
  ['running', '运行中', Activity],
  ['stopped', '已停止', CircleStop],
  ['error', '异常', CircleAlert],
] as const
function InstanceLink({ row }: { row: Sandbox }) {
  return (
    <NavLink
      to={'/sandboxes/' + row.id}
      end
      aria-label={'查看 ' + nameOf(row)}
      className="sbx-instance-link"
      title={nameOf(row)}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{nameOf(row)}</span>
        <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-txt2">
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn(
                'size-1.5 rounded-full border border-current',
                row.status === 'running' && 'bg-current',
              )}
            />
            {statuses[row.status] || row.status}
          </span>
          <span aria-hidden="true">·</span>
          <span className="truncate" title={row.spec.image}>{row.spec.image}</span>
        </span>
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-txt3" />
    </NavLink>
  )
}
function InstanceSidebar({
  source,
  state,
}: {
  source: Source
  state: State<Sandbox[]> & { refresh: () => void }
}) {
  const [status, filter] = useState('')
  const rows = state.value ?? []
  const result = rows.filter((row) => !status || row.status === status)
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1)
  return (
    <aside className="sbx-instance-sidebar" aria-labelledby="instances">
      <div className="sbx-instance-sidebar-head">
        <div className="flex items-center justify-between gap-2">
          <h2 id="instances" className="text-base">实例列表</h2>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="刷新实例列表"
            title="刷新实例列表"
            onClick={state.refresh}
            disabled={state.loading}
          >
            <RefreshCw className={cn(state.loading && 'motion-safe:animate-spin')} />
          </Button>
        </div>
        <CreateSandbox source={source} />
        <div className="sbx-instance-filters" role="group" aria-label="按状态筛选">
          {filters.map(([value, label, Icon]) => (
            <Button
              key={value}
              variant="ghost"
              aria-pressed={status === value}
              onClick={() => filter(value)}
              className="h-8 justify-between gap-1 px-1.5 text-xs aria-pressed:bg-accent-dim aria-pressed:text-txt"
            >
              <span className="inline-flex items-center gap-1.5">
                <Icon aria-hidden="true" />
                {label}
              </span>
              <span className="tabular-nums">
                {state.value ? (value ? counts.get(value) ?? 0 : rows.length) : '·'}
              </span>
            </Button>
          ))}
        </div>
      </div>
      <div className="sbx-instance-scroll">
        {(!state.value || state.error) && (
          <div className="p-3"><AsyncState state={state} /></div>
        )}
        {state.value && !result.length && !state.error && (
          <div className="px-3 py-5 text-xs text-txt2">
            <p role="status">{rows.length ? '没有匹配的实例' : '暂无沙箱实例'}</p>
            {rows.length > 0 && (
              <Button variant="link" size="sm" className="px-0" onClick={() => filter('')}>
                显示全部
              </Button>
            )}
          </div>
        )}
        {result.length > 0 && (
          <ul className="divide-y divide-line" aria-labelledby="instances">
            {result.map((row) => (
              <li key={row.id}><InstanceLink row={row} /></li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
function InstanceLayout({ source }: { source: Source }) {
  const { pathname } = useLocation()
  const hasDetail = Boolean(useMatch('/sandboxes/:id'))
  const list = useLoad((signal) => source.list(signal), [source, pathname])
  return (
    <div className="sbx-instance-layout" data-detail={hasDetail}>
      <InstanceSidebar source={source} state={list} />
      <div className="sbx-instance-content" key={pathname}>
        <Outlet context={list.refresh} />
      </div>
    </div>
  )
}
function InstanceOverview() {
  return (
    <main className="sbx-instance-overview" aria-labelledby="instances-heading">
      <Boxes aria-hidden="true" className="size-6 text-txt2" />
      <h1 id="instances-heading" className="text-lg">未选择实例</h1>
    </main>
  )
}
function InspectorSection({
  title,
  children,
  defaultOpen,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="border-b border-line last:border-0"
    >
      <h3>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="group h-11 w-full justify-between px-2 text-left"
          >
            <span>{title}</span>
            <ChevronDown className="text-txt3 transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent className="px-2 pb-4 pt-1">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
function Logs({ source, id }: { source: Source; id: string }) {
  const state = useLoad((s) => source.logs(id, s), [source, id])
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-txt3">最近 200 行</span>
        <Button
          variant="outline"
          size="sm"
          onClick={state.refresh}
          disabled={state.loading}
        >
          <RefreshCw />
          刷新日志
        </Button>
      </div>
      {(state.error || state.value === undefined) && (
        <AsyncState state={state} />
      )}
      {state.value !== undefined && (
        <pre
          tabIndex={0}
          aria-label="实例日志输出"
          className="max-h-80 overflow-auto whitespace-pre-wrap break-all border border-line bg-elevated p-3 text-xs leading-5 text-txt2"
        >
          {state.value || '暂无日志'}
        </pre>
      )}
    </div>
  )
}
function DetailsRoute({ source }: { source: Source }) {
  const id = useParams<'id'>().id!
  const refreshList = useOutletContext<() => void>()
  return <Details key={id} source={source} id={id} refreshList={refreshList} />
}
function Details({
  source,
  id,
  refreshList,
}: {
  source: Source
  id: string
  refreshList: () => void
}) {
  const navigate = useNavigate(),
    deleting = useRef(false)
  const state = useLoad(
    async (signal) => {
      try {
        return await source.detail(id, signal)
      } catch (error) {
        if (
          !signal.aborted &&
          deleting.current &&
          error instanceof GatewayError &&
          error.status === 404
        )
          navigate('/sandboxes', { replace: true })
        throw error
      }
    },
    [source, id],
  )
  const row = state.value
  const lastListSnapshot = useRef<string>(undefined)
  const listSnapshot = row && `${row.revision}:${row.status}`
  useEffect(() => {
    if (!listSnapshot) return
    if (lastListSnapshot.current && lastListSnapshot.current !== listSnapshot) refreshList()
    lastListSnapshot.current = listSnapshot
  }, [listSnapshot, refreshList])
  useEffect(() => {
    if (!row?.operation || state.loading) return
    deleting.current = row.operation.kind === 'delete'
    const timer = setTimeout(state.refresh, 1000)
    return () => clearTimeout(timer)
  }, [row, source, state.refresh, state.loading])
  return (
    <main className="page-shell page-content space-y-4">
      <Link
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          '-ml-2',
        )}
        to="/sandboxes"
      >
        <ArrowLeft />
        实例列表
      </Link>
      {!row ? (
        <AsyncState state={state} />
      ) : (
        <>
          <div className="page-heading pb-1">
            <div className="flex min-w-0 items-start gap-3">
              <span className="icon-tile size-10 shrink-0">
                <Box className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h1 className="break-all">{nameOf(row)}</h1>
                  <StatusBadge status={row.status} />
                </div>
                <code className="break-all text-xs text-txt3">
                  {row.spec.labels.name ? row.id : row.spec.image}
                </code>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Refresh state={state} />
              {source.manage && (
                <Link
                  className={buttonVariants({ variant: 'outline' })}
                  to={`/sandboxes/${row.id}/observations`}
                >
                  <Activity />
                  网络观测
                </Link>
              )}
              <Actions source={source} row={row} refresh={state.update} />
            </div>
          </div>
          {row.operation && (
            <p role="status" className="text-sm text-txt3">
              Gateway 正在处理：{row.operation.kind}
            </p>
          )}
          {row.error && (
            <Alert className="border-err/30 bg-err/10 text-err">
              {row.error}
            </Alert>
          )}
          {state.error && <AsyncState state={state} />}
          <div className="sbx-detail-grid">
            <EndpointWorkbench
              key={`${row.id}:${row.resource.generation}`}
              row={row}
              source={source}
              snapshotFailed={Boolean(state.error)}
            />
            <aside
              aria-label="实例检查"
              className="sbx-detail-inspector"
            >
              <h2 className="px-2 pb-2 pt-1 text-xs font-semibold text-txt3">
                实例检查
              </h2>
              <InspectorSection title="实例规格" defaultOpen>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                  {Object.entries({
                    镜像: row.spec.image,
                    资源配额: `${row.spec.cpus} CPU · ${memory(row.spec.memory_mb)}`,
                    '资源 / 数据代际': `${row.resource.generation} / ${row.resource.data_generation}`,
                    修订号: row.revision,
                    当前操作: row.operation?.kind || '无',
                    运行配置: row.spec.runtime_profile || '默认',
                  }).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-txt3">{k}</dt>
                      <dd className="break-all text-txt2">{v}</dd>
                    </div>
                  ))}
                </dl>
              </InspectorSection>
              <InspectorSection
                title={`服务端点（${row.endpoints.length}）`}
                defaultOpen
              >
                {row.endpoints.length ? (
                  <ul className="divide-y divide-line">
                    {row.endpoints.map((e) => (
                      <li
                        key={e.name}
                        className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                      >
                        <div className="min-w-0 break-all">
                          <div className="font-medium">{e.name}</div>
                          <code className="text-xs text-txt3">
                            {e.protocol} :{e.port} · {e.bundle}
                          </code>
                        </div>
                        <Badge
                          variant="outline"
                          className={
                            e.ready ? 'border-ok/20 text-ok' : 'text-txt3'
                          }
                        >
                          {e.ready ? '就绪' : '不可用'}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-txt3">暂无端点</p>
                )}
              </InspectorSection>
              <InspectorSection title="实例日志">
                <Logs source={source} id={id} />
              </InspectorSection>
              <InspectorSection title="端点访问（独立 CLI）">
                <CliTools />
              </InspectorSection>
            </aside>
          </div>
        </>
      )}
    </main>
  )
}
function App() {
  const config = useLoad(loadSource, [])
  return (
    <>
      <Header source={config.value} />
      {!config.value ? (
        <main className="page-shell page-content">
          <AsyncState state={config} />
        </main>
      ) : (
        <Routes>
          <Route element={<InstanceLayout source={config.value} />}>
            <Route index element={<InstanceOverview />} />
            <Route path="sandboxes" element={<InstanceOverview />} />
            <Route path="sandboxes/:id" element={<DetailsRoute source={config.value} />} />
          </Route>
          <Route
            path="registry"
            element={<CapabilityRegistry source={config.value} />}
          />
          <Route
            path="access"
            element={<AccessSetup source={config.value} />}
          />
          <Route
            path="sandboxes/:id/observations/:run?"
            element={<ObservationRoute source={config.value} />}
          />
          <Route
            path="*"
            element={
              <main className="page-shell page-content">
                页面不存在 <Link to="/sandboxes">实例列表</Link>
              </main>
            }
          />
        </Routes>
      )}
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <div className="sbx-app">
      <App />
    </div>
  </HashRouter>,
)
