import { useEffect, useRef, useState } from 'react'
import { cancelAttempt, inspectAttempt, startAttempt, type AttemptResult, type AttemptTarget } from '@/shared/api/agent-executor'
import { errorMessage } from '@/shared/api'
import { ApiError } from '@/shared/http/client'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/textarea'
import { ArtifactFiles } from './ArtifactFiles'

interface Props {
  target: AttemptTarget | null
  workPatchId?: string
  storageKey?: string
}

const labels: Record<AttemptResult['status'], string> = {
  starting: '启动中', running: '运行中', unverified: '待核实',
  succeeded: '已完成', failed: '失败', cancelled: '已取消',
}

interface Attempt {
  id: string
  phase: 'start' | 'cancel' | 'inspect' | 'watch' | 'error' | 'done'
  result?: AttemptResult
  preview?: string
  message?: string
}

function received(attempt: Attempt, result: AttemptResult): Attempt {
  if (result?.attemptId !== attempt.id || !Object.hasOwn(labels, result.status)) throw new Error('服务未返回本次尝试的有效状态。')
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(result.status)
  return { ...attempt, result, phase: terminal ? 'done' : 'watch', message: undefined }
}

function restore(key?: string): Attempt | null {
  try {
    const id = key && localStorage.getItem(key)
    return id ? { id, phase: 'inspect' } : null
  } catch { return null }
}

function previewKey(target: Props['target']) {
  const d = target?.previewDefinition
  return d && JSON.stringify([d.id, d.agent.configPackageId])
}

function newUuid() {
  if (crypto.randomUUID) return crypto.randomUUID()
  // randomUUID 仅在安全上下文可用，内网 HTTP 同样需要合法的 v4 UUID。
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export function AttemptPanel(props: Props) {
  return <AttemptSession key={props.storageKey} {...props} />
}

function AttemptSession({ target, workPatchId, storageKey }: Props) {
  const [instruction, setInstruction] = useState('')
  const [attempt, setAttempt] = useState(() => restore(storageKey))
  const mutation = useRef<AbortController | null>(null)
  useEffect(() => () => mutation.current?.abort(), [])

  // 每次只调度一次 GET。下一次读取由本次响应决定，终态不再调度。
  useEffect(() => {
    if (!attempt || (attempt.phase !== 'inspect' && attempt.phase !== 'watch')) return
    const controller = new AbortController()
    const { signal } = controller
    async function inspect(current: Attempt) {
      try {
        const next = received(current, await inspectAttempt(current.id, signal))
        if (!signal.aborted) setAttempt(prev => prev === current ? next : prev)
      } catch (cause) {
        if (signal.aborted) return
        const missing = cause instanceof ApiError && cause.status === 404
        const message = [current.message, `查询失败：${errorMessage(cause)}`].filter(Boolean).join('。')
        setAttempt(prev => prev === current ? { ...current, phase: missing ? 'done' : 'error', message } : prev)
      }
    }
    const timer = attempt.phase === 'watch' ? window.setTimeout(() => void inspect(attempt), 1000) : undefined
    if (timer === undefined) void inspect(attempt)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [attempt])

  const canStart = !!target && !!instruction.trim() && (!attempt || attempt.phase === 'done')
  async function start() {
    if (!canStart || !target || mutation.current) return
    const id = newUuid()
    const current: Attempt = { id, preview: previewKey(target), phase: 'start' }
    try { if (storageKey) localStorage.setItem(storageKey, id) } catch { /* 仍可在当前面板核对。 */ }
    const controller = new AbortController()
    mutation.current = controller
    setAttempt(current)
    try {
      const result = await startAttempt(id, { ...target, ...(workPatchId ? { workPatchId } : {}), workInstruction: { encoding: 'utf-8', text: instruction } }, controller.signal)
      if (!controller.signal.aborted) setAttempt(received(current, result))
    } catch (cause) {
      // PUT 的回执丢失不代表任务不存在。后续所有恢复操作只读原 ID。
      if (!controller.signal.aborted) setAttempt({ ...current, phase: 'inspect', message: `启动未确认：${errorMessage(cause)}` })
    } finally { mutation.current = null }
  }

  async function cancel() {
    if (!attempt || mutation.current) return
    const controller = new AbortController()
    mutation.current = controller
    setAttempt({ ...attempt, phase: 'cancel', message: undefined })
    try {
      const result = await cancelAttempt(attempt.id, controller.signal)
      if (!controller.signal.aborted) setAttempt(received(attempt, result))
    } catch (cause) {
      if (!controller.signal.aborted) setAttempt({ ...attempt, phase: 'inspect', message: `取消未确认：${errorMessage(cause)}` })
    } finally { mutation.current = null }
  }

  const result = attempt?.result
  const stale = attempt?.preview !== undefined && attempt.preview !== previewKey(target)
  return <section aria-label="执行尝试" className="space-y-3 border-y border-line py-4">
    <h3 className="font-semibold">{target?.executorRef ? `运行 ${target.executorRef.id} v${target.executorRef.revision}` : '执行器试运行'}</h3>
    <label className="field"><span className="field-label">本次指令</span>
      <Textarea rows={3} value={instruction} onChange={e => setInstruction(e.target.value)} />
    </label>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="primary" icon="play" disabled={!canStart} loading={attempt?.phase === 'start'} onClick={start}>{target?.previewDefinition ? '试跑' : '启动'}</Button>
      {!target && <span className="text-sm text-txt3">当前没有可启动的执行目标。</span>}
      {(attempt?.phase === 'watch' || attempt?.phase === 'cancel' || (attempt?.phase === 'error' && result)) &&
        <Button type="button" icon="stop" loading={attempt.phase === 'cancel'} onClick={cancel}>取消</Button>}
    </div>
    {attempt && <div className="space-y-2 border-t border-line pt-3 text-sm">
      <p className="break-all text-txt3">尝试 ID：<code>{attempt.id}</code></p>
      <p role="status">{attempt.phase === 'start' ? '正在启动…' : attempt.phase === 'cancel' ? '正在取消…' : attempt.phase === 'inspect' ? '正在核对状态…' : result ? labels[result.status] : '尚未确认状态'}</p>
      {stale && <p className="text-warn">旧配置的试跑结果</p>}
      {attempt.message && <p role="alert" className="text-err">{attempt.message}</p>}
      {attempt.message && attempt.phase !== 'inspect' && <Button type="button" size="sm" icon="refresh" onClick={() => setAttempt({ ...attempt, phase: 'inspect', message: undefined })}>重新查询</Button>}
      {result?.artifactDirectoryId && <ArtifactFiles key={result.artifactDirectoryId} id={result.artifactDirectoryId} />}
    </div>}
  </section>
}
