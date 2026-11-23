import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Activity, AlertCircle, ArrowDown, ChevronDown, ListOrdered, MessageSquare, Radio, RefreshCw, TriangleAlert, Wrench, type LucideIcon } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import type { TraceEvent } from './use-attempt'

const phaseLabels = {
  idle: '未开始', submitting: '提交中', observing: '跟踪中', settled: '已结束', unconfirmed: '待核实',
}
const stateLabels = {
  running: '运行中', idle: '空闲', requires_action: '等待操作', unknown: '不可观测',
}
const stopLabels = {
  end_turn: '本轮结束', cancelled: '已取消', error: '执行出错', refusal: '已拒绝',
  max_tokens: '达到令牌上限', max_turn_requests: '达到本轮请求上限',
}
const toolLabels = {
  pending: '等待中', in_progress: '运行中', completed: '已完成', failed: '失败', paused: '已暂停', cancelled: '已取消',
}
const gapLabels = {
  early_update_limit: '会话建立前的更新超出缓冲上限', retention_limit: '达到轨迹留存上限',
  event_size_limit: '事件大小超过上限', event_write_failed: '事件未能写入',
  transport_closed: 'ACP 连接中断', execution_unverified: '未能核实执行情况', worker_lost: '执行进程失联',
}
const rpcLabels = {
  initialize: '协商 ACP 版本与能力',
  'session/new': '建立会话',
  'session/prompt': '提交任务指令',
  'session/cancel': '请求停止执行',
  'session/close': '关闭会话',
}
const rpcPhaseLabels = { sent: '已发送', ack: '收到回执', failed: '未确认调用成功' }

function label(labels: Record<string, string>, key: string, fallback: string) {
  return Object.hasOwn(labels, key) ? labels[key] : fallback
}

function toolName(name: string | undefined) {
  if (!name) return undefined
  const chars = Array.from(name.replace(/\s+/gu, ' ').trim())
  return chars.length > 64 ? `${chars.slice(0, 64).join('')}…` : chars.join('') || undefined
}

type TraceRow =
  | Exclude<TraceEvent, { kind: 'message' | 'tool' }>
  | { kind: 'message'; seq: number; lastSeq: number; messageId: string; chunk: boolean; count: number }
  | { kind: 'tool'; seq: number; call: number; name?: string; status?: string }

function traceRows(events: TraceEvent[]): TraceRow[] {
  const rows: TraceRow[] = []
  const tools = new Map<string, { call: number; name?: string }>()
  for (const event of events) {
    if (event.kind === 'message') {
      const last = rows.at(-1)
      if (last?.kind === 'message' && last.chunk && event.chunk && last.messageId === event.messageId && last.lastSeq + 1 === event.seq) {
        last.lastSeq = event.seq
        last.count += 1
      } else {
        rows.push({ kind: 'message', seq: event.seq, lastSeq: event.seq, messageId: event.messageId, chunk: event.chunk, count: 1 })
      }
    } else if (event.kind === 'tool') {
      const previous = tools.get(event.toolCallId)
      const tool = { call: previous?.call ?? tools.size + 1, name: toolName(event.name) ?? previous?.name }
      tools.set(event.toolCallId, tool)
      rows.push({ kind: 'tool', seq: event.seq, ...tool, status: event.status })
    } else {
      rows.push(event)
    }
  }
  return rows
}

function describe(row: TraceRow): { Icon: LucideIcon; title: string; detail?: string; code?: string; tone?: string } {
  switch (row.kind) {
    case 'state':
      return {
        Icon: Activity,
        title: `会话状态：${label(stateLabels, row.state, '未知')}`,
        detail: row.stopReason ? label(stopLabels, row.stopReason, '结束原因未知') : undefined,
      }
    case 'message':
      return { Icon: MessageSquare, title: row.chunk ? `收到回复片段 × ${row.count}` : '收到完整回复' }
    case 'tool':
      return {
        Icon: Wrench, title: `工具 #${row.call}`, code: row.name,
        detail: row.status ? label(toolLabels, row.status, '状态未知') : '信息更新',
        tone: row.status === 'failed' ? 'text-err' : undefined,
      }
    case 'gap':
      return {
        Icon: TriangleAlert, title: '轨迹缺口', tone: 'text-warn',
        detail: label(gapLabels, row.reason, '部分事件未能记录'),
      }
    case 'rpc':
      return {
        Icon: Radio, title: label(rpcLabels, row.method, 'ACP 方法调用'),
        code: Object.hasOwn(rpcLabels, row.method) ? row.method : undefined,
        detail: label(rpcPhaseLabels, row.phase, '调用状态未知'),
        tone: row.phase === 'failed' ? 'text-err' : undefined,
      }
  }
}

function atLatest(viewport: HTMLDivElement) {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 4
}

export function TracePanel({ attemptId, phase, events, error, onRetry }: {
  attemptId: string | null
  phase: 'idle' | 'submitting' | 'observing' | 'settled' | 'unconfirmed'
  events: TraceEvent[]
  error: string
  onRetry: () => void
}) {
  const headingId = useId()
  const contentId = useId()
  const rows = useMemo(() => traceRows(events), [events])
  const [open, setOpen] = useState(false)
  const [awayFromLatest, setAwayFromLatest] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)

  const syncScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport?.clientHeight) return
    if (following.current) viewport.scrollTop = viewport.scrollHeight
    else if (atLatest(viewport)) {
      following.current = true
      setAwayFromLatest(false)
    }
  }, [])

  useLayoutEffect(() => {
    following.current = true
    setAwayFromLatest(false)
  }, [attemptId])
  useLayoutEffect(syncScroll, [attemptId, rows, syncScroll])
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    // Reconcile when the panel becomes visible or its scrollport changes size.
    const observer = new ResizeObserver(syncScroll)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [syncScroll])

  return (
    <aside aria-labelledby={headingId} className="min-w-0 self-start rounded-md border border-line bg-surface">
      <header className="relative flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 pr-9 lg:pr-3">
        <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-txt">
          <ListOrdered className="size-4 shrink-0 text-txt3" aria-hidden="true" />
          ACP 执行过程
        </h2>
        <span className={`ml-auto text-xs ${phase === 'unconfirmed' ? 'text-warn' : 'text-txt3'}`}>
          {phaseLabels[phase]}
        </span>
        <button type="button" aria-expanded={open} aria-controls={contentId}
          aria-label={open ? '折叠 ACP 执行过程' : '展开 ACP 执行过程'}
          onClick={() => setOpen(value => !value)}
          className="absolute inset-0 flex items-center justify-end rounded-md px-3 text-txt3 hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 lg:hidden">
          <ChevronDown className={`size-4 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </header>
      <div id={contentId} className={`border-t border-line ${open ? 'block' : 'hidden lg:block'}`}>
        {error && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2 text-xs">
            <p role="alert" className="flex items-center gap-1.5 text-err">
              <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />读取轨迹失败
            </p>
            {attemptId && <Button size="sm" onClick={onRetry}><RefreshCw className="size-3.5" aria-hidden="true" />重试读取</Button>}
          </div>
        )}
        <div ref={viewportRef} role="region" aria-label="ACP 事件" tabIndex={rows.length ? 0 : undefined}
          className="max-h-[30dvh] overflow-y-auto overscroll-y-contain lg:max-h-[60dvh] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
          onScroll={({ currentTarget }) => {
            if (!currentTarget.clientHeight) return
            following.current = atLatest(currentTarget)
            setAwayFromLatest(!following.current)
          }}>
          {rows.length ? (
            <ol className="divide-y divide-line">
              {rows.map(row => {
                const { Icon, title, detail, code, tone } = describe(row)
                const last = row.kind === 'message' ? row.lastSeq : row.seq
                return (
                  <li key={row.seq} className="grid grid-cols-[2.5rem_0.875rem_minmax(0,1fr)] items-start gap-x-2 px-3 py-1.5 text-xs leading-5">
                    <span className="text-right font-mono tabular-nums text-txt3">{row.seq}{last !== row.seq && <span className="sr-only"> 至 {last}</span>}</span>
                    <Icon className={`mt-0.5 size-3.5 ${tone ?? 'text-txt3'}`} aria-hidden="true" />
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className={row.kind === 'gap' ? 'font-medium text-warn' : 'font-medium text-txt'}>{title}</span>
                      {code && <code className="min-w-0 break-all text-txt2"><bdi>{code}</bdi></code>}
                      {detail && <span className={tone ?? 'text-txt3'}>{detail}</span>}
                    </div>
                  </li>
                )
              })}
            </ol>
          ) : (
            <p className="px-3 py-3 text-xs text-txt3">
              {!attemptId ? '暂无执行尝试' : error ? '尚未读取到事件' : phase === 'settled' || phase === 'unconfirmed' ? '暂无轨迹记录' : '等待 ACP 事件…'}
            </p>
          )}
        </div>
        {awayFromLatest && (
          <div className="flex justify-end border-t border-line px-3 py-2">
            <Button size="sm" variant="ghost" onClick={() => {
              following.current = true
              syncScroll()
              setAwayFromLatest(false)
              viewportRef.current?.focus({ preventScroll: true })
            }}><ArrowDown className="size-3.5" aria-hidden="true" />回到最新</Button>
          </div>
        )}
      </div>
    </aside>
  )
}
