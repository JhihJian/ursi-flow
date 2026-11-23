import { useCallback, useEffect, useRef, useState } from 'react'
import { cancelAttempt, inspectAttempt, startAttempt, type AttemptResult, type ExecutorRef } from '@/shared/api/agent-executor'
import { ApiError, requestV2 } from '@/shared/http/client'
import { newUuid } from '@/shared/lib/uuid'

type Reply = { id: string; text: string }

type Result = AttemptResult & { artifactError?: string }
type Phase = 'idle' | 'submitting' | 'observing' | 'settled' | 'unconfirmed'
export type TraceEvent = { seq: number } & (
  | { kind: 'state'; state: string; stopReason?: string }
  | { kind: 'rpc'; method: string; phase: string }
  | { kind: 'message'; messageId: string; chunk: boolean; text: string }
  | { kind: 'tool'; toolCallId: string; name?: string; status?: string }
  | { kind: 'gap'; reason: string }
)
type EventPage = { events: TraceEvent[]; nextCursor: number }

interface View {
  id: string | null
  result: Result | undefined
  phase: Phase
  statusError: string
  traceError: string
  cancelError: string
  cancelling: boolean
  cancelRequested: boolean
  events: TraceEvent[]
  replies: Reply[]
  statusRead: number
  traceRead: number
}

interface Session {
  id: string
  view: View
  lifetime: AbortController
  cursor: number
  events: Map<number, TraceEvent>
}

const storageKey = 'ursi.executor-platform.agent-attempt'
const pollMs = 1000
const traceWaitMs = 8000
const idle: View = {
  id: null, result: undefined, phase: 'idle', statusError: '', traceError: '', cancelError: '',
  cancelling: false, cancelRequested: false, events: [], replies: [], statusRead: 0, traceRead: 0,
}

function traceMode({ phase, result }: View) {
  return phase === 'observing' || phase === 'unconfirmed' || (phase === 'settled' && result) ? phase : null
}

function openSession(id: string, phase: Phase): Session {
  return { id, view: { ...idle, id, phase }, lifetime: new AbortController(), cursor: 0, events: new Map() }
}

function forget(id: string) {
  try {
    if (sessionStorage.getItem(storageKey) === id) sessionStorage.removeItem(storageKey)
  } catch { /* The current view can still be reset. */ }
}

function terminal(status: Result['status'] | undefined) {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

function readResult(id: string, result: Result): Pick<View, 'result' | 'phase' | 'statusError'> {
  if (result?.attemptId !== id) throw new Error('服务未返回本次尝试的有效状态。')
  if (terminal(result.status)) return { result, phase: 'settled', statusError: '' }
  if (result.status === 'starting' || result.status === 'running') return { result, phase: 'observing', statusError: '' }
  if (result.status === 'unverified') return { result, phase: 'unconfirmed', statusError: '' }
  throw new Error('服务返回了未知的尝试状态。')
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

function definitelyRejected(cause: unknown) {
  return cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 404 && cause.status !== 408
}

function canRetryTrace(cause: unknown) {
  return cause instanceof TypeError || (cause instanceof ApiError && (cause.status === 408 || cause.status === 429 || cause.status >= 500))
}

function mergePage(session: Session, page: EventPage): Pick<View, 'events' | 'replies'> {
  const { cursor, events } = session
  if (!Array.isArray(page?.events) || !Number.isSafeInteger(page.nextCursor)
    || (page.events.length ? page.nextCursor <= cursor : page.nextCursor !== cursor)
    || page.events.some(event => !Number.isSafeInteger(event?.seq) || event.seq <= 0 || event.seq > page.nextCursor)) {
    throw new Error('服务返回了无效的事件游标。')
  }
  session.cursor = page.nextCursor
  const size = events.size
  for (const event of page.events) if (!events.has(event.seq)) events.set(event.seq, event)
  if (size === events.size) return { events: session.view.events, replies: session.view.replies }

  // Derive both views from the same committed sequence.
  const ordered = [...events.values()].sort((a, b) => a.seq - b.seq)
  const replies = new Map<string, Reply>()
  for (const event of ordered) {
    if (event.kind !== 'message') continue
    const prefix = event.chunk ? replies.get(event.messageId)?.text ?? '' : ''
    replies.set(event.messageId, { id: event.messageId, text: prefix + event.text })
  }
  return { events: ordered, replies: [...replies.values()] }
}

export function useAttempt() {
  const [view, setView] = useState(idle)
  const current = useRef<Session | null>(null)

  const update = useCallback((session: Session, patch: Partial<View>) => {
    if (current.current !== session) return
    session.view = { ...session.view, ...patch }
    setView(session.view)
  }, [])

  useEffect(() => {
    let id: string | null = null
    try { id = sessionStorage.getItem(storageKey) } catch { /* No attempt can be restored. */ }
    if (id) {
      current.current = openSession(id, 'observing')
      setView(current.current.view)
    }
    return () => {
      current.current?.lifetime.abort()
      current.current = null
    }
  }, [])

  const { id, phase, statusRead, traceRead } = view
  useEffect(() => {
    const session = current.current
    if (!session || session.id !== id || phase !== 'observing') return
    const controller = new AbortController()
    const { signal } = controller
    let timer: number | undefined

    async function inspect(session: Session) {
      try {
        const result = await inspectAttempt(session.id, signal)
        if (signal.aborted || current.current !== session || session.view.statusRead !== statusRead || terminal(session.view.result?.status)) return
        const next = readResult(session.id, result)
        update(session, next.phase === 'settled' ? { ...next, cancelError: '' } : next)
        if (next.phase === 'observing') timer = window.setTimeout(() => void inspect(session), pollMs)
      } catch (cause) {
        if (!signal.aborted && session.view.statusRead === statusRead && !terminal(session.view.result?.status)) {
          const statusError = [session.view.statusError, `查询状态失败：${message(cause)}`].filter(Boolean).join('\n')
          update(session, { phase: 'unconfirmed', statusError })
        }
      }
    }

    void inspect(session)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [id, phase, statusRead, update])

  // Changing modes aborts any wait and starts a fresh drain from the shared cursor.
  const mode = traceMode(view)
  useEffect(() => {
    const session = current.current
    if (!session || session.id !== id || !mode) return
    const controller = new AbortController()
    const { signal } = controller
    const isCurrent = () => !signal.aborted && current.current === session
      && session.view.phase === mode && session.view.traceRead === traceRead
    const path = `/executor-attempts/${encodeURIComponent(session.id)}/events`
    let first = true
    let timer: number | undefined

    const readTrace = async () => {
      try {
        while (isCurrent()) {
          const wait = !first && mode === 'observing' ? `&waitMs=${traceWaitMs}` : ''
          first = false
          const page = await requestV2<EventPage>(`${path}?after=${session.cursor}${wait}`, { signal })
          if (!isCurrent()) return
          const trace = mergePage(session, page)
          if (trace.events !== session.view.events || session.view.traceError) update(session, { ...trace, traceError: '' })
          if (!page.events.length) {
            if (mode === 'observing') timer = window.setTimeout(() => void readTrace(), pollMs)
            return
          }
        }
      } catch (cause) {
        if (!isCurrent()) return
        update(session, { traceError: `读取轨迹失败：${message(cause)}` })
        if (canRetryTrace(cause)) timer = window.setTimeout(() => void readTrace(), pollMs)
      }
    }

    void readTrace()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [id, mode, traceRead, update])

  function start(ref: ExecutorRef, text: string) {
    if (current.current || !text.trim()) return
    const id = newUuid()
    try { sessionStorage.setItem(storageKey, id) }
    catch { setView({ ...idle, statusError: '无法保存尝试 ID，未提交任务。' }); return }

    const session = openSession(id, 'submitting')
    current.current = session
    setView(session.view)
    const { signal } = session.lifetime
    void (async () => {
      try {
        const result = await startAttempt(id, { executorRef: ref, workInstruction: { encoding: 'utf-8', text } }, signal)
        if (!signal.aborted) update(session, readResult(id, result))
      } catch (cause) {
        if (signal.aborted) return
        const rejected = definitelyRejected(cause)
        if (rejected) forget(id)
        // A lost reply does not imply the task was rejected. Only GET may follow it.
        update(session, { phase: rejected ? 'settled' : 'observing', statusError: `${rejected ? '提交失败' : '提交未确认'}：${message(cause)}` })
      }
    })()
  }

  function cancel() {
    const session = current.current
    if (!session) return
    const { phase, result, cancelling, cancelRequested } = session.view
    if ((phase !== 'observing' && phase !== 'unconfirmed') || !result || cancelling || cancelRequested) return

    update(session, { cancelling: true, cancelError: '' })
    const { signal } = session.lifetime
    void (async () => {
      try {
        const result = await cancelAttempt(session.id, signal)
        if (signal.aborted) return
        // A confirmed outcome observed during the POST remains authoritative.
        if (terminal(session.view.result?.status)) update(session, { cancelling: false })
        else update(session, { ...readResult(session.id, result), cancelling: false, cancelRequested: true, statusRead: session.view.statusRead + 1 })
      } catch (cause) {
        if (signal.aborted) return
        if (terminal(session.view.result?.status)) update(session, { cancelling: false })
        else update(session, { phase: 'observing', cancelling: false, cancelError: `取消未确认：${message(cause)}`, statusRead: session.view.statusRead + 1 })
      }
    })()
  }

  function retry() {
    const session = current.current
    if (!session) return
    const { phase, cancelError, statusRead } = session.view
    if (phase === 'unconfirmed') update(session, { phase: 'observing', statusError: '', cancelError: '', statusRead: statusRead + 1 })
    else if (phase === 'observing' && cancelError) update(session, { cancelError: '', statusRead: statusRead + 1 })
  }

  function retryTrace() {
    const session = current.current
    if (!session || !traceMode(session.view)) return
    update(session, { traceError: '', traceRead: session.view.traceRead + 1 })
  }

  function reset() {
    const session = current.current
    if (session && session.view.phase !== 'settled' && session.view.phase !== 'unconfirmed') return
    // The caller owns confirmation for discarding an unconfirmed attempt.
    if (session) {
      current.current = null
      session.lifetime.abort()
      forget(session.id)
    }
    setView(idle)
  }

  const { result, statusError, traceError, cancelError, cancelling, cancelRequested, events, replies } = view
  const error = [statusError, cancelError].filter(Boolean).join('\n')
  return { id, result, phase, error, traceError, cancelling, cancelRequested, events, replies, start, cancel, retry, retryTrace, reset }
}
