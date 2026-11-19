import { useState } from 'react'
import { errorMessage, runtime } from '@/shared/api'
import type { FlowConfig } from '@/shared/api/types'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'

export function Config() {
  const resource = useResource<FlowConfig | null>(runtime.config, null)
  return <div className="page-stack"><PageHeader title="运行配置" description="新运行使用当前配置" />
    <ResourceState {...resource} onRetry={resource.reload} />{resource.data && <ConfigForm initial={resource.data} />}
  </div>
}
function ConfigForm({ initial }: { initial: FlowConfig }) {
  const [saved, setSaved] = useState(initial)
  const [model, setModel] = useState(initial.model)
  const [limit, setLimit] = useState(String(initial.maxConcurrent))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const dirty = saved.model !== model || saved.maxConcurrent !== Number(limit)
  async function save() {
    const patch: Partial<FlowConfig> = {}
    if (saved.model !== model) patch.model = model
    if (saved.maxConcurrent !== Number(limit)) patch.maxConcurrent = Number(limit)
    setBusy(true); setError(''); setSuccess(false)
    try {
      const updated = await runtime.configure(patch)
      setSaved(updated); setModel(updated.model); setLimit(String(updated.maxConcurrent)); setSuccess(true)
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <form className="panel max-w-2xl p-5" onSubmit={e => { e.preventDefault(); void save() }}><fieldset disabled={busy} className="space-y-5">
    <label className="field"><span className="field-label">执行器</span><Input readOnly value={saved.executor} /></label>
    <label className="field"><span className="field-label">模型</span><Input value={model} onChange={e => setModel(e.target.value)} placeholder="使用执行器默认模型" /></label>
    <label className="field"><span className="field-label">最大并发数</span><Input type="number" required min={1} max={64} step={1} value={limit} onChange={e => setLimit(e.target.value)} /></label>
    {error && <p role="alert" className="text-sm text-err">{error}</p>}{success && !dirty && <p role="status" className="text-sm text-ok">配置已保存。</p>}
    <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>保存配置</Button>
  </fieldset></form>
}
