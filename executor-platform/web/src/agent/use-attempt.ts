import { useCallback, useEffect, useRef, useState } from 'react'
import { cancelAttempt, inspectAttempt, startAttempt, type AttemptResult, type ExecutorRef } from '@/shared/api/agent-executor'
import { ApiError, requestV2 } from '@/shared/http/client'
import { newUuid } from '@/shared/lib/uuid'

export type TraceEntry = { kind: 'message'; id: string; text: string } | { kind: 'tool'; id: string; name?: string; status?: string }

type Result = AttemptResult & { artifactError?: string }
type Phase = 'idle' | 'submitting' | 'observing' | 'settled' | 'unconfirmed'
type TraceEvent = { seq: number } & (
  | { kind: 'state' }
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
  entries: TraceEntry[]
  gaps: string[]
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
const idle: View = {
  id: null, result: undefined, phase: 'idle', statusError: '', traceError: '', cancelError: '',
  cancelling: false, cancelRequested: false, entries: [], gaps: [], statusRead: 0, traceRead: 0,
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

function mergePage(session: Session, page: EventPage): Pick<View, 'entries' | 'gaps'> {
  const { cursor, events } = session
  if (!Array.isArray(page?.events) || !Number.isSafeInteger(page.nextCursor)
    || (page.events.length ? page.nextCursor <= cursor : page.nextCursor !== cursor)
    || page.events.some(event => !Number.isSafeInteger(event?.seq) || event.seq <= 0 || event.seq > page.nextCursor)) {
    throw new Error('服务返回了无效的事件游标。')
  }
  session.cursor = page.nextCursor
  const size = events.size
  for (const event of page.events) if (!events.has(event.seq)) events.set(event.seq, event)
  if (size === events.size) return { entries: session.view.entries, gaps: session.view.gaps }

  // Rebuild the bounded trace in sequence order so late events never undo newer patches.
  const entries = new Map<string, TraceEntry>()
  const gaps: string[] = []
  for (const event of [...events.values()].sort((a, b) => a.seq - b.seq)) {
    if (event.kind === 'message') {
      const key = `message:${event.messageId}`
      const previous = entries.get(key)
      const prefix = event.chunk && previous?.kind === 'message' ? previous.text : ''
      entries.set(key, { kind: 'message', id: event.messageId, text: prefix + event.text })
    } else if (event.kind === 'tool') {
      const key = `tool:${event.toolCallId}`
      const previous = entries.get(key)
      entries.set(key, {
        ...previous, kind: 'tool', id: event.toolCallId,
        ...(event.name !== undefined ? { name: event.name } : {}),
        ...(event.status !== undefined ? { status: event.status } : {}),
      })
    } else if (event.kind === 'gap') gaps.push(event.reason)
  }
  return { entries: [...entries.values()], gaps }
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

  // Begin a fresh drain once status is terminal, even if an earlier poll saw an empty page.
  const traceMode = phase === 'observing' || phase === 'unconfirmed' || (phase === 'settled' && view.result) ? phase : null
  useEffect(() => {
    const session = current.current
    if (!session || session.id !== id || !traceMode) return
    const controller = new AbortController()
    const { signal } = controller
    let timer: number | undefined

    async function readTrace(session: Session) {
      try {
        while (!signal.aborted && current.current === session) {
          const page = await requestV2<EventPage>(`/executor-attempts/${encodeURIComponent(session.id)}/events?after=${session.cursor}`, { signal })
          if (signal.aborted || current.current !== session) return
          const trace = mergePage(session, page)
          if (trace.entries !== session.view.entries || session.view.traceError) update(session, { ...trace, traceError: '' })
          if (!page.events.length) {
            if (traceMode === 'observing') timer = window.setTimeout(() => void readTrace(session), pollMs)
            return
          }
        }
      } catch (cause) {
        if (!signal.aborted) update(session, { traceError: `读取轨迹失败：${message(cause)}` })
      }
    }

    void readTrace(session)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [id, traceMode, traceRead, update])

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
    const { phase, traceError, cancelError, statusRead, traceRead } = session.view
    if (phase === 'unconfirmed') update(session, { phase: 'observing', statusError: '', traceError: '', cancelError: '', statusRead: statusRead + 1 })
    else if (traceError) update(session, { traceError: '', traceRead: traceRead + 1 })
    else if (phase === 'observing' && cancelError) update(session, { cancelError: '', statusRead: statusRead + 1 })
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

  const { result, statusError, traceError, cancelError, cancelling, cancelRequested, entries, gaps } = view
  const error = [statusError, traceError, cancelError].filter(Boolean).join('\n')
  return { id, result, phase, error, cancelling, cancelRequested, entries, gaps, start, cancel, retry, reset }
}
