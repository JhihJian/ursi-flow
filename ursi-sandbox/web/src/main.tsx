import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity,
  ArrowLeft,
  Box,
  Boxes,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Cpu,
  Layers3,
  ListFilter,
  Network,
  RefreshCw,
  Search,
  Server,
  Terminal,
} from 'lucide-react'
import {
  HashRouter,
  Link,
  Route,
  Routes,
  useParams,
  useNavigate,
} from 'react-router'
import type { LucideIcon } from 'lucide-react'
import { CreateSandbox, Actions, CliTools } from './Management'
import { Button } from './shared/ui/button'
import { Input } from './shared/ui/input'
import { Select } from './shared/ui/select'
import { Badge as UiBadge } from './shared/ui/badge'
import { Alert } from './shared/ui/alert'
import { loadSource, GatewayError, type Source, type Sandbox } from './data'
import { initAppearance } from './theme'
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
  deps: React.DependencyList,
) {
  const [seq, refresh] = React.useReducer((n) => n + 1, 0)
  const run = React.useRef(0)
  const [state, set] = useState<State<T>>({ loading: true })
  useEffect(() => {
    const ctl = new AbortController(),
      current = ++run.current
    set({ loading: true })
    Promise.resolve()
      .then(() => load(ctl.signal))
      .then(
        (value) => {
          if (!ctl.signal.aborted && current === run.current) set({ value })
        },
        (e) => {
          if (!ctl.signal.aborted && current === run.current)
            set({ error: e.message })
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
    <div role="status" className="empty">
      {state.error ? (
        <>
          <CircleAlert />
          {state.error}
          <Button variant="outline" onClick={state.refresh}>
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
function Badge({ status }: { status: string }) {
  const tone =
    status === 'error'
      ? 'destructive'
      : status === 'running'
        ? 'default'
        : 'secondary'
  return <UiBadge variant={tone}>{statuses[status] || status}</UiBadge>
}
function Refresh({ state }: { state: RequestState }) {
  return (
    <Button variant="outline" onClick={state.refresh} loading={state.loading}>
      <RefreshCw />
      刷新
    </Button>
  )
}
function Header({ source }: { source?: Source }) {
  return (
    <header>
      <div className="bar">
        <Link className="brand" to="/sandboxes">
          <span className="logo">
            <Boxes size={22} />
          </span>
          Ursi Sandbox
        </Link>
        <span className="sep">/</span>
        <span className="crumb">资源控制台</span>
        {source && (
          <span className="mode">
            <Server size={14} />
            {source.demo
              ? '演示数据'
              : source.manage
                ? 'Gateway · 管理员'
                : 'Gateway · 只读'}
          </span>
        )}
      </div>
    </header>
  )
}
function List({ source }: { source: Source }) {
  const state = useLoad((s) => source.list(s), [source])
  const [q, search] = useState(''),
    [status, filter] = useState('')
  const rows = state.value || [],
    term = q.trim().toLowerCase()
  const result = rows.filter(
    (r) =>
      (!status || r.status === status) &&
      [nameOf(r), r.id, r.spec.image].some((s) =>
        s.toLowerCase().includes(term),
      ),
  )
  const stats: [string, string, LucideIcon][] = [
    ['', '全部实例', Layers3],
    ['running', '运行中', Activity],
    ['stopped', '已停止', CircleStop],
    ['error', '异常', CircleAlert],
  ]
  return (
    <main>
      <div className="heading">
        <div>
          <h1>沙箱管理</h1>
        </div>
        <Refresh state={state} />
        <CreateSandbox source={source} />
      </div>
      <div className="stats">
        {stats.map(([value, label, Icon]) => (
          <Button
            key={label}
            variant="outline"
            aria-pressed={status === value}
            onClick={() => filter(value)}
            className={'stat ' + (value || 'all')}
          >
            <span className="stat-title">
              <Icon size={16} />
              {label}
            </span>
            <strong>
              {state.value
                ? rows.filter((r) => !value || r.status === value).length
                : '·'}
            </strong>
          </Button>
        ))}
      </div>
      <section aria-label="沙箱实例">
        <div className="tools">
          <h2>
            <Box />
            实例列表
          </h2>
          <div className="filters">
            <label className="field">
              <Search />
              <Input
                aria-label="搜索实例"
                placeholder="搜索名称、ID 或镜像"
                value={q}
                onChange={(e) => search(e.target.value)}
              />
            </label>
            <label className="field">
              <ListFilter />
              <Select
                aria-label="实例状态"
                value={status}
                onChange={(e) => filter(e.target.value)}
              >
                <option value="">全部状态</option>
                {Object.entries(statuses).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        </div>
        {!state.value ? (
          <AsyncState state={state} />
        ) : !result.length ? (
          <div className="empty" role="status">
            <Boxes />
            {rows.length ? '没有匹配的实例' : '暂无沙箱实例'}
            {rows.length > 0 && (
              <Button
                variant="outline"
                onClick={() => {
                  search('')
                  filter('')
                }}
              >
                清除筛选
              </Button>
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    '实例名称 / ID',
                    '运行状态',
                    '容器镜像',
                    '资源配额',
                    '端点',
                    '',
                  ].map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.map((r) => (
                  <tr key={r.id}>
                    <td className="identity">
                      <Link to={'/sandboxes/' + r.id}>
                        <span className="cube">
                          <Box size={18} />
                        </span>
                        <span>
                          <b>{nameOf(r)}</b>
                          <small>{r.id.slice(0, 12)}</small>
                        </span>
                      </Link>
                    </td>
                    <td className="state">
                      <Badge status={r.status} />
                    </td>
                    <td className="image mono" data-label="镜像">
                      {r.spec.image}
                    </td>
                    <td className="quota" data-label="资源">
                      {r.spec.cpus} CPU · {memory(r.spec.memory_mb)}
                    </td>
                    <td className="count" data-label="端点">
                      <Network size={14} />
                      {r.endpoints.length}
                    </td>
                    <td className="action">
                      <Link
                        to={'/sandboxes/' + r.id}
                        aria-label={'查看 ' + nameOf(r)}
                        title="查看详情"
                      >
                        <ChevronRight size={17} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {state.value && (
          <footer>
            显示 {result.length} / {rows.length} 个实例
          </footer>
        )}
      </section>
    </main>
  )
}
function Logs({ source, id }: { source: Source; id: string }) {
  const state = useLoad((s) => source.logs(id, s), [source, id])
  return (
    <section>
      <div className="tools">
        <h2>
          <Terminal />
          实例日志 <small>最近 200 行</small>
        </h2>
        <Refresh state={state} />
      </div>
      {state.error || state.loading ? (
        <AsyncState state={state} />
      ) : (
        <pre>{state.value || '暂无日志'}</pre>
      )}
    </section>
  )
}
function Endpoints({ source, id }: { source: Source; id: string }) {
  const state = useLoad((s) => source.endpoints(id, s), [source, id])
  return (
    <section>
      <div className="tools">
        <h2>
          <Network />
          端点查询 <small>gateway endpoints</small>
        </h2>
        <Refresh state={state} />
      </div>
      {state.error || state.loading ? (
        <AsyncState state={state} />
      ) : (
        <ul>
          {(state.value || []).map((e) => (
            <li key={e.name}>
              <b>{e.name}</b>
              <code>{e.address}</code>
              <span>
                {e.port} / {e.visibility === 'internal' ? '内部' : '公开'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
function Details({ source }: { source: Source }) {
  const id = useParams<'id'>().id!
  const navigate = useNavigate(),
    deleting = React.useRef(false)
  const state = useLoad(
      async (s) => {
        try {
          return await source.detail(id, s)
        } catch (e) {
          if (
            !s.aborted &&
            deleting.current &&
            e instanceof GatewayError &&
            e.status === 404
          )
            navigate('/sandboxes', { replace: true })
          throw e
        }
      },
      [source, id],
    ),
    r = state.value
  useEffect(() => {
    if (source.demo || !r?.operation) return
    deleting.current = r.operation.kind === 'delete'
    const timer = setTimeout(state.refresh, 1000)
    return () => clearTimeout(timer)
  }, [r, source, state.refresh])
  return (
    <main>
      <Link className="back" to="/sandboxes">
        <ArrowLeft size={16} />
        实例列表
      </Link>
      {!r ? (
        <AsyncState state={state} />
      ) : (
        <>
          <div className="heading">
            <div>
              <h1>{nameOf(r)}</h1>
              <small>{r.id}</small>
            </div>
            <Refresh state={state} />
          </div>
          <Badge status={r.status} />
          <Actions source={source} row={r} refresh={state.update} />
          {r.error && (
            <Alert className="mt-3 border-err/30 bg-err/10 text-err">
              {r.error}
            </Alert>
          )}
          <section>
            <h2>
              <Cpu />
              实例规格
            </h2>
            <dl>
              {Object.entries({
                镜像: r.spec.image,
                资源配额: `${r.spec.cpus} CPU · ${memory(r.spec.memory_mb)}`,
                '资源 / 数据代际': `${r.resource.generation} / ${r.resource.data_generation}`,
                修订号: r.revision,
                当前操作: r.operation?.kind || '无',
                运行配置: r.spec.runtime_profile || '默认',
              }).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <h2>
              <Network />
              服务端点
            </h2>
            {r.endpoints.length ? (
              <ul>
                {r.endpoints.map((e) => (
                  <li key={e.name}>
                    <b>{e.name}</b>
                    <code>{e.address}</code>
                    <span>
                      {e.port} / {e.visibility === 'internal' ? '内部' : '公开'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">暂无端点</p>
            )}
          </section>
          <Logs source={source} id={id} />
          <Endpoints source={source} id={id} />
          <CliTools />
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
        <AsyncState state={config} />
      ) : (
        <Routes>
          <Route index element={<List source={config.value} />} />
          <Route path="sandboxes" element={<List source={config.value} />} />
          <Route
            path="sandboxes/:id"
            element={<Details source={config.value} />}
          />
          <Route
            path="*"
            element={
              <main>
                页面不存在 <Link to="/sandboxes">实例列表</Link>
              </main>
            }
          />
        </Routes>
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
