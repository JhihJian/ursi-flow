import { useState } from 'react'
import { useNavigate } from 'react-router'
import { runtime, errorMessage } from '@/shared/api'
import { Input } from '@/shared/ui/input'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/textarea'

export function StartRun({ id, disabled }: { id: string; disabled: boolean }) {
  const navigate = useNavigate()
  const [variables, setVariables] = useState('{}')
  const [runId, setRunId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function start() {
    setBusy(true); setError('')
    try {
      let parsed: unknown
      try { parsed = JSON.parse(variables) } catch { throw new Error('变量必须是合法的 JSON 对象。') }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('变量必须是 JSON 对象。')
      const job = await runtime.start(id, parsed as Record<string, unknown>, runId.trim() || undefined)
      navigate(`/runs/${encodeURIComponent(job.id)}`)
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <form className="panel space-y-4 p-5" onSubmit={e => { e.preventDefault(); void start() }}>
    <h2 className="font-semibold">启动运行</h2><p className="text-sm text-txt3">工作区：default</p>
    <label className="field"><span className="field-label">Run ID（选填）</span><Input pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,95}" value={runId} onChange={e => setRunId(e.target.value)} /></label>
    <label className="field"><span className="field-label">变量（JSON 对象）</span><Textarea className="font-mono" value={variables} onChange={e => setVariables(e.target.value)} /></label>
    {error && <p role="alert" className="text-sm text-err">{error}</p>}
    <Button type="submit" variant="primary" disabled={disabled} loading={busy}>启动 Run</Button>{disabled && <span className="ml-2 text-sm text-txt3">请先保存包文件。</span>}
  </form>
}
