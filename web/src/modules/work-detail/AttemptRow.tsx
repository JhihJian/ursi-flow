import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { requestV2 } from '@/shared/http/client'
import { Button } from '@/shared/ui/button'
import { errorMessage } from '@/shared/api'
import { active, attemptStatus, post, type Attempt, type Write } from './model'

const validEvidence = (s: string) => !!s.trim() && new TextEncoder().encode(s).length <= 4096

export function AttemptRow({ base, attempt, open, toggle, busy, visible, write, update }: {
  base: string; attempt: Attempt; open: boolean; toggle: () => void; busy: boolean; visible: boolean
  write: Write; update: (attempt: Attempt) => void
}) {
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [status, setStatus] = useState('failed')
  const [evidence, setEvidence] = useState('')
  const [reason, setReason] = useState('')
  const path = `${base}/attempts/${encodeURIComponent(attempt.id)}`
  const observe = active(attempt) || (visible && open)
  useEffect(() => {
    if (!observe || busy) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function query() {
      try {
        const result = await requestV2<Attempt>(path, { signal: controller.signal })
        if (controller.signal.aborted) return
        setError('')
        update(result)
        if (active(result)) timer = setTimeout(query, 2000)
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause))
      }
    }
    void query()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [path, busy, observe, retry, update])
  if (!visible) return null
  const executor = attempt.executor
  const sandbox = executor.environment === 'sandbox'
  const environment = executor.kind === 'flow' ? 'Flow' : sandbox ? '沙箱' : '本地 Agent'
  const verify = () => write(async () => update(await post<Attempt>(`${path}/verify`, { status, evidence, reason })))
  return <article className="min-w-0 border-b border-line py-3">
    <button className="grid w-full gap-1 text-left sm:grid-cols-[2fr_2fr_1fr_1fr]" aria-expanded={open} onClick={toggle}>
      <strong>{attempt.action}</strong><span>{executor.id} v{executor.revision}</span>
      <span>{environment} · {attempt.workspace}</span><span>{attemptStatus[attempt.status]}</span>
      <small className="break-all text-txt3 sm:col-span-4">{attempt.id}</small>
    </button>
    {error && <p role="alert" className="text-err">查询执行记录失败：{error} <Button onClick={() => setRetry(n => n + 1)}>重新查询</Button></p>}
    {open && <div className="mt-3 space-y-3 border-l-2 border-line pl-3">
      {executor.kind === 'flow' && <p>{executor.flowId} @ {executor.flowRevision} <Link className="text-accent-2 underline" to={`/runs/${encodeURIComponent(attempt.id)}`}>查看 Run 节点历史</Link></p>}
      {sandbox && attempt.backendRunId && <p>会话标识：{attempt.backendRunId}</p>}
      <h3 className="font-medium">本次输出</h3><pre className="whitespace-pre-wrap break-words">{attempt.output ?? '暂无输出'}</pre>
      {attempt.interruptedStatus && <p>中断前状态：{attempt.interruptedStatus}</p>}
      {attempt.verification && <div className="space-y-1"><h3 className="font-medium">核实记录</h3>
        <p>核实结论：{attemptStatus[attempt.status]}</p><p>证据：{attempt.verification.evidence}</p><p>原因：{attempt.verification.reason}</p>
        {attempt.verification.daemonEvidence != null && <pre className="whitespace-pre-wrap">{JSON.stringify(attempt.verification.daemonEvidence, null, 2)}</pre>}
      </div>}
      {active(attempt) && <Button disabled={busy} variant="danger" onClick={() => void write(async () => update(await post<Attempt>(`${path}/cancel`)))}>取消本次执行</Button>}
      {attempt.status === 'unverified' && <fieldset disabled={busy} className="max-w-2xl space-y-2"><legend className="font-semibold">人工核实</legend>
        <p>先确认进程已结束，并检查本次执行可能产生的副作用。</p>
        <label className="field">核实结论<select className="select" value={status} onChange={e => setStatus(e.target.value)}><option value="failed">失败</option><option value="cancelled">取消</option></select></label>
        <label className="field">核实证据<textarea className="textarea" value={evidence} onChange={e => setEvidence(e.target.value)} /></label>
        <label className="field">核实原因<textarea className="textarea" value={reason} onChange={e => setReason(e.target.value)} /></label>
        <Button disabled={!validEvidence(evidence) || !validEvidence(reason)} onClick={() => void verify()}>提交核实</Button>
      </fieldset>}
    </div>}
  </article>
}
