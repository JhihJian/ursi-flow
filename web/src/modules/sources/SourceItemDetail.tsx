import { useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { errorMessage } from '@/shared/api'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { dispatchSource, readSourceItem, sourceItemPath, sourceItemsPath, sourceRequestId } from './model'

export function SourceItemDetail() {
  const { provider, id } = useParams()
  const navigate = useNavigate()
  const result = useResource(signal => readSourceItem(provider!, id!, signal), null)
  const [action, setAction] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const requestRef = useRef<{ action: string; id: string } | null>(null)
  const item = result.data
  async function dispatch() {
    if (!item || busy || !action) return
    if (!requestRef.current || requestRef.current.action !== action) requestRef.current = { action, id: sourceRequestId(provider!, id!) }
    setBusy(true); setError('')
    try {
      const work = await dispatchSource(provider!, id!, requestRef.current.id, action)
      navigate(`/items/${encodeURIComponent(work.id)}`)
    } catch (cause) {
      setError(`${errorMessage(cause)} 请求标识已保留，重试不会重复派工。`)
    } finally { setBusy(false) }
  }
  if (!item || result.loading || result.error) return <ResourceState loading={result.loading} error={result.error} onRetry={result.reload} />
  return <article className="page-stack break-words">
    <PageHeader title="来源条目详情" description={provider} actions={<Button asChild><Link to={sourceItemsPath(provider!)}>返回条目</Link></Button>} />
    <section className="panel space-y-5 p-4 sm:p-5">
      <div><h2 className="break-words text-lg font-semibold">{item.title}</h2><p className="mt-1 break-all text-sm text-txt3">{item.id}</p></div>
      <div><h3 className="field-label">条目材料</h3><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-base p-3 text-sm">{JSON.stringify(item.input, null, 2)}</pre></div>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"><label className="field"><span className="field-label">固定动作</span><Select aria-label="固定动作" value={action} onChange={event => { setAction(event.target.value); setError('') }}><option value="">请选择动作</option>{item.actions.map(name => <option key={name} value={name}>{name}</option>)}</Select></label><Button variant="primary" loading={busy} disabled={!action} onClick={() => void dispatch}>派工</Button></div>
      {error && <p role="alert" className="break-words text-sm text-err">{error}</p>}
    </section>
    <Link className="text-sm text-accent-2 hover:underline" to={sourceItemPath(provider!, id!)}>刷新条目详情</Link>
  </article>
}
