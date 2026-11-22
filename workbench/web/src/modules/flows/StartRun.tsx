import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ExecutorRefPicker } from '@/modules/agent-executor/ExecutorRefPicker'
import { runtime, errorMessage } from '@/shared/api'
import type { ExecutorRef } from '@/shared/api/agent-executor'
import { useResource } from '@/shared/hooks/use-resource'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { Input } from '@/shared/ui/input'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/textarea'

/** Flow 编辑器保留 Runtime 默认执行模式；委派时必须明确选定已发布版本。 */
export function StartRun({ id, disabled }: { id: string; disabled: boolean }) {
  const [delegate, setDelegate] = useState(false)
  const [ref, setRef] = useState<ExecutorRef | null>(null)
  return <section className="panel space-y-4 p-5"><h2 className="font-semibold">启动运行</h2>
    <label className="field">执行方式<Select value={delegate ? 'platform' : 'runtime'} onChange={e => { setDelegate(e.target.value === 'platform'); setRef(null) }}>
      <option value="runtime">Runtime 默认执行器</option><option value="platform">平台执行器修订</option>
    </Select></label>
    {delegate && <ExecutorRefPicker selected={ref} onSelect={setRef} />}
    <RunForm id={id} executorRef={ref} disabled={disabled || (delegate && !ref)} />
    {disabled && <p className="text-sm text-txt3">请先保存包文件。</p>}
  </section>
}

export function PickFlowRun({ executorRef }: { executorRef: ExecutorRef | null }) {
  const flows = useResource(runtime.flows, [])
  const [id, setId] = useState('')
  if (flows.loading || flows.error || !flows.data.length) return <ResourceState loading={flows.loading} error={flows.error} empty title={flows.error ? '读取 Flow 失败' : '暂无 Flow 包'} onRetry={flows.reload} />
  return <section className="panel space-y-4 p-5"><label className="field">Flow 包<Select value={id} onChange={e => setId(e.target.value)}>
    <option value="">选择 Flow</option>{flows.data.map(flow => <option key={flow} value={flow}>{flow}</option>)}
  </Select></label><RunForm key={id} id={id} executorRef={executorRef} disabled={!id || !executorRef} /></section>
}

function RunForm({ id, executorRef, disabled }: { id: string; executorRef: ExecutorRef | null; disabled: boolean }) {
  const navigate = useNavigate()
  const [variables, setVariables] = useState('{}')
  const [runId, setRunId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function start() {
    if (disabled || busy) return
    setBusy(true); setError('')
    try {
      let parsed: unknown
      try { parsed = JSON.parse(variables) } catch { throw new Error('变量必须是合法的 JSON 对象。') }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('变量必须是 JSON 对象。')
      const job = await runtime.start(id, parsed as Record<string, unknown>, runId.trim() || undefined, executorRef ?? undefined)
      navigate(`/runs/${encodeURIComponent(job.id)}`)
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <form className="space-y-4" onSubmit={e => { e.preventDefault(); void start() }}>
    <p className="text-sm text-txt3">工作区：default</p>
    <label className="field"><span className="field-label">Run ID（选填）</span><Input pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,95}" value={runId} onChange={e => setRunId(e.target.value)} /></label>
    <label className="field"><span className="field-label">变量（JSON 对象）</span><Textarea className="font-mono" value={variables} onChange={e => setVariables(e.target.value)} /></label>
    {error && <p role="alert" className="text-sm text-err">{error}</p>}
    <Button type="submit" variant="primary" disabled={disabled} loading={busy}>启动 Run</Button>
  </form>
}
