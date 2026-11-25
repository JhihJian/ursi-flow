import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  ArrowLeft,
  Copy,
  FolderOpen,
  Play,
  RefreshCw,
  Square,
} from 'lucide-react'
import { GatewayError, json, type Sandbox, type Source } from './data'
import { apiUrl } from './api-base'
import { Button, buttonVariants } from './shared/ui/button'
import { Input } from './shared/ui/input'
import { SegmentPreview } from './SegmentPreview'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const write = { method: 'POST', headers: { 'X-Ursi-Action': 'manage' } }
const api = (id: string) => apiUrl(`./api/v1/sandboxes/${id}/observations`)
const route = (id: string) => `/sandboxes/${id}/observations`
interface Snapshot {
  observation_id: string
  sandbox_id: string
  generation: number
  started_ms: number
  ended_ms: number | null
  state: string
  reason: string | null
  error: string | null
  packets: number
  bytes: number
  segments: number
  kernel_drops: number
  queue_drops: number
}
const final = (r: Snapshot) => r.ended_ms != null || r.state === 'interrupted'
const states: Record<string, string> = {
  starting: '正在初始化',
  running: '采集中',
  stopped: '已停止',
  degraded: '丢包或截断',
  limited: '达到配额',
  interrupted: '异常中断',
  error: '采集错误',
}
function message(e: unknown) {
  if (e instanceof GatewayError)
    return (
      (
        {
          401: '身份验证失败',
          403: '需要管理员身份',
          404: '记录或资源不存在',
          409: '状态冲突，请核对容器状态或打开已有观测',
          501: '网络观测未启用',
          503: '观测服务暂不可用',
        } as Record<number, string>
      )[e.status] || e.message
    )
  return e instanceof Error ? e.message : '请求失败'
}
const lost = (e: unknown) =>
  e instanceof GatewayError && [401, 403, 404].includes(e.status)
const datetime = (ms: number) => new Date(ms).toLocaleString()

export function ObservationRoute({ source }: { source: Source }) {
  const { id = '', run } = useParams()
  return (
    <main className="page-shell page-content space-y-4">
      <Link
        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        to={`/sandboxes/${id}`}
      >
        <ArrowLeft />
        实例详情
      </Link>
      <div className="page-heading">
        <div>
          <h1>网络观测</h1>
          <code className="break-all text-sbx-txt3">沙箱 {id}</code>
        </div>
      </div>
      {!source.manage ? (
        <p role="alert">需要管理员身份</p>
      ) : !/^[a-f0-9]{32}$/.test(id) || (run && !uuid.test(run)) ? (
        <p role="alert">无效的观测地址</p>
      ) : run ? (
        <Observation key={`${id}/${run}`} id={id} run={run} />
      ) : (
        <Launch key={id} source={source} id={id} />
      )}
    </main>
  )
}
function Launch({ id, source }: { id: string; source: Source }) {
  const navigate = useNavigate(),
    [row, setRow] = useState<Sandbox>(),
    [issue, setIssue] = useState(''),
    [busy, setBusy] = useState(false),
    [lookup, setLookup] = useState(''),
    [seq, retry] = useState(0)
  const lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const c = new AbortController()
    lifetime.current = c
    setIssue('')
    setRow(undefined)
    source.detail(id, c.signal).then(
      (r) => {
        if (!c.signal.aborted) setRow(r)
      },
      (e) => {
        if (!c.signal.aborted) setIssue(message(e))
      },
    )
    return () => c.abort()
  }, [source, id, seq])
  const enabled = source.capabilities.observer_enabled
  async function begin() {
    const c = lifetime.current
    if (!c || busy) return
    setBusy(true)
    setIssue('')
    try {
      const r = await json<Snapshot>(api(id), c.signal, write)
      if (r.sandbox_id !== id || !uuid.test(r.observation_id))
        throw Error('观测记录无效')
      if (!c.signal.aborted) navigate(`${route(id)}/${r.observation_id}`)
    } catch (e) {
      if (!c.signal.aborted) setIssue(message(e))
    } finally {
      if (!c.signal.aborted) setBusy(false)
    }
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-y border-sbx-line py-4">
        <Button
          variant="primary"
          disabled={
            !enabled ||
            row?.status !== 'running' ||
            Boolean(row?.operation) ||
            busy
          }
          onClick={begin}
        >
          <Play />
          开始观测
        </Button>
        <span>
          {!enabled
            ? 'Gateway 未启用网络观测'
            : row
              ? `代际 ${row.resource.generation} · ${row.status === 'running' && !row.operation ? '实例就绪' : '实例尚未就绪'}`
              : '正在读取实例状态'}
        </span>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => retry((v) => v + 1)}
        >
          <RefreshCw />
          刷新
        </Button>
      </div>
      {issue && (
        <p role="alert" className="text-sbx-err">
          {issue}
        </p>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (uuid.test(lookup.trim()))
            navigate(`${route(id)}/${lookup.trim()}`)
        }}
      >
        <label className="grid gap-1">
          已有观测 ID
          <Input
            value={lookup}
            placeholder="观测 UUID"
            onChange={(e) => setLookup(e.target.value)}
          />
        </label>
        <Button variant="outline" disabled={!uuid.test(lookup.trim())}>
          <FolderOpen />
          打开记录
        </Button>
      </form>
    </>
  )
}

type Point = { time: number; bytes: number; rate: number | null }
function Observation({ id, run }: { id: string; run: string }) {
  const base = `${api(id)}/${run}`,
    [snap, setSnap] = useState<Snapshot>(),
    [points, setPoints] = useState<Point[]>([]),
    [last, setLast] = useState(0),
    [error, setError] = useState(''),
    [actionError, setActionError] = useState(''),
    [stop, setStop] = useState(false),
    [seq, retry] = useState(0),
    [denied, setDenied] = useState(false),
    [copy, setCopy] = useState('')
  const action = useRef<AbortController | null>(null)
  useEffect(() => () => action.current?.abort(), [])
  function forget() {
    setSnap(undefined)
    setPoints([])
    setLast(0)
    setStop(false)
    setCopy('')
  }
  useEffect(() => {
    if (denied) return
    let disposed = false,
      controller: AbortController | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      gap = true,
      ended = false
    async function poll() {
      if (disposed || document.hidden || ended) return
      controller?.abort()
      const ctl = new AbortController()
      controller = ctl
      try {
        const r = await json<Snapshot>(base, ctl.signal)
        if (disposed || ctl.signal.aborted) return
        if (r.observation_id !== run || r.sandbox_id !== id)
          throw Error('返回的观测身份不匹配')
        const time = Date.now(),
          continuous = !gap
        gap = false
        setSnap(r)
        setLast(time)
        setError('')
        ended = final(r)
        setPoints((old) => {
          const previous = old.at(-1)
          const elapsed = previous ? time - previous.time : 0
          const rate =
            continuous &&
            previous &&
            elapsed > 0 &&
            elapsed <= 4500 &&
            r.bytes >= previous.bytes
              ? ((r.bytes - previous.bytes) * 1000) / elapsed / 1024
              : null
          return [
            ...old.filter((p) => p.time > time - 60000),
            { time, bytes: r.bytes, rate },
          ]
        })
      } catch (e) {
        if (disposed || ctl.signal.aborted) return
        gap = true
        setError(message(e))
        if (lost(e)) {
          forget()
          ended = true
        }
      }
      if (!disposed && !ended && !document.hidden)
        timer = setTimeout(poll, 2000)
    }
    function visibility() {
      clearTimeout(timer)
      controller?.abort()
      gap = true
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', visibility)
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [base, id, run, seq, denied])
  function revoke() {
    action.current?.abort()
    forget()
    setDenied(true)
    setError('无权读取观测记录')
    setActionError('')
  }
  async function requestStop() {
    if (stop) return
    setStop(true)
    setActionError('')
    const c = new AbortController()
    action.current = c
    try {
      await json<Snapshot>(`${base}/stop`, c.signal, write)
      if (!c.signal.aborted) retry((n) => n + 1)
    } catch (e) {
      if (c.signal.aborted) return
      if (e instanceof GatewayError && [401, 403].includes(e.status)) revoke()
      else {
        setStop(false)
        setActionError(message(e))
      }
    }
  }
  const ended = snap && final(snap),
    state = error
      ? '状态未知'
      : snap
        ? (states[snap.state] ?? snap.state)
        : '正在读取'
  return (
    <>
      <div className="page-heading border-y border-sbx-line py-3">
        <div>
          <strong role="status">
            {stop && !ended && !error ? '正在收尾' : state}
          </strong>
          <p className="break-all font-mono text-xs text-sbx-txt3">{run}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(location.href)
                setCopy('已复制链接')
              } catch {
                setCopy('请复制浏览器地址栏中的记录链接')
              }
            }}
          >
            <Copy />
            复制链接
          </Button>
          {snap && !ended && (
            <Button disabled={stop || Boolean(error)} onClick={requestStop}>
              <Square />
              停止观测
            </Button>
          )}
          <Link className={buttonVariants({ variant: 'ghost' })} to={route(id)}>
            观测入口
          </Link>
        </div>
      </div>
      {copy && <p role="status">{copy}</p>}
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sbx-warn"
        >
          {error}
          {last > 0 && ` · 最后快照 ${datetime(last)}`}
          <Button
            variant="outline"
            onClick={() => {
              setDenied(false)
              retry((n) => n + 1)
            }}
          >
            <RefreshCw />
            重试
          </Button>
        </div>
      )}
      {actionError && (
        <p role="alert" className="text-sbx-err">
          {actionError}
        </p>
      )}
      {snap && (
        <>
          <p className="text-sbx-txt3">
            代际 {snap.generation} · 开始 {datetime(snap.started_ms)}
            {snap.ended_ms != null && ` · 结束 ${datetime(snap.ended_ms)}`}
            {snap.reason &&
              ` · ${{ requested: '按请求停止', container_exited: '容器退出', observer_interrupted: 'Observer 中断' }[snap.reason] ?? snap.reason}`}
          </p>
          <dl className="grid grid-cols-2 gap-4 border-b border-sbx-line pb-4 sm:grid-cols-4">
            {[
              ['已写报文', snap.packets],
              ['PCAP 大小（B）', snap.bytes],
              ['内核丢包', snap.kernel_drops],
              ['队列丢包', snap.queue_drops],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-sbx-txt3">{k}</dt>
                <dd className="break-all font-mono text-xl font-semibold">
                  {v.toLocaleString()}
                </dd>
              </div>
            ))}
          </dl>
          {snap.error && (
            <p role="alert" className="break-words text-sbx-err">
              {snap.error}
            </p>
          )}
          {snap.state === 'interrupted' && (
            <p className="text-sbx-warn">计数来自最后一次快照，末段可能不完整。</p>
          )}
          {ended && !error ? (
            <SegmentPreview
              base={base}
              segments={snap.segments}
              onAccessDenied={revoke}
            />
          ) : (
            !ended && <RateChart points={points} />
          )}
        </>
      )}
    </>
  )
}
function RateChart({ points }: { points: Point[] }) {
  const current = points.at(-1),
    rates = points.filter((p) => p.rate !== null),
    peak = Math.max(0, ...rates.map((p) => p.rate!))
  return (
    <section className="space-y-2">
      <div className="page-heading">
        <h2 className="font-semibold">PCAP 写入速率</h2>
        <span className="text-xs text-sbx-txt3">
          最近 60 秒 ·{' '}
          {current?.rate != null
            ? `${current.rate.toFixed(1)} KiB/s`
            : '等待下一次读数'}{' '}
          · 峰值 {peak.toFixed(1)} KiB/s
        </span>
      </div>
      <svg
        viewBox="0 0 600 80"
        preserveAspectRatio="none"
        className="h-24 w-full border-b border-sbx-line text-sbx-accent-2"
        role="img"
        aria-label="最近一分钟 PCAP 写入速率，缺失的采样区间留白"
      >
        {current &&
          rates.map((p) => {
            const height = Math.max(1, (75 * p.rate!) / (peak || 1))
            return (
              <rect
                key={p.time}
                x={580 - (current.time - p.time) / 100}
                y={80 - height}
                width="16"
                height={height}
                fill="currentColor"
              />
            )
          })}
      </svg>
    </section>
  )
}
