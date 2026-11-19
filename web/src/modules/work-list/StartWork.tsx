import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { errorMessage } from '@/shared/api'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { Textarea } from '@/shared/ui/textarea'
import { createItem, readPackage, readPackages, type InputType, type WorkPackage } from './model'
import { createRequestIds } from './dispatch'

function initialSelection(packages: WorkPackage[], params: URLSearchParams) {
  const id = params.get('package') || packages[0]?.id || ''
  const match = packages.find(item => item.id === id)
  const revision = Number(params.get('revision')) || match?.revision || 0
  return { id, revision }
}

export function StartWork() {
  const location = useLocation()
  const navigate = useNavigate()
  const packages = useResource(readPackages, [])
  const [selection, setSelection] = useState({ id: '', revision: 0 })
  const initialized = useRef(false)
  useEffect(() => {
    if (!initialized.current && packages.data.length) {
      initialized.current = true
      setSelection(initialSelection(packages.data, new URLSearchParams(location.search)))
    }
  }, [packages.data, location.search])
  const updateSelection = (id: string, revision: number) => {
    setSelection({ id, revision })
    const query = new URLSearchParams({ package: id, revision: String(revision) })
    navigate(`/items/new?${query}`)
  }
  const selected = packages.data.find(item => item.id === selection.id)
  return <div className="page-stack break-words">
    <PageHeader title="发起工作" description="选择已发布的工作包版本，创建一张待办理工作项" actions={<Button asChild><Link to="/items">返回工作清单</Link></Button>} />
    <ResourceState loading={packages.loading && packages.data.length === 0} error={packages.error} empty={!packages.loading && !packages.error && packages.data.length === 0}
      title={packages.error ? undefined : '暂无可用工作包'} description="请先发布一个工作包版本，再从这里发起工作。" onRetry={packages.reload}>
      <Button asChild><Link to="/packages">进入工作包目录</Link></Button>
    </ResourceState>
    {packages.data.length > 0 && <>
      <section className="panel space-y-4 p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <label className="field"><span className="field-label">工作包</span><Select aria-label="工作包" value={selection.id} onChange={event => {
            const next = packages.data.find(item => item.id === event.target.value)
            if (next) updateSelection(next.id, next.revision)
          }}>{packages.data.map(item => <option key={item.id} value={item.id}>{item.id} · 最新 v{item.revision}</option>)}</Select></label>
          <label className="field"><span className="field-label">修订版本</span><Input aria-label="修订版本" type="number" min="1" value={selection.revision || ''} onChange={event => updateSelection(selection.id, Number(event.target.value) || 0)} /></label>
        </div>
      </section>
      {selected && selection.revision > 0 && <PackageForm key={`${selection.id}:${selection.revision}`} packageId={selection.id} revision={selection.revision} />}
    </>}
  </div>
}

function parseValue(type: InputType, value: string | boolean): unknown {
  if (type === 'boolean') return value === true || value === 'true'
  if (type === 'number') return Number(value)
  if (type === 'integer') return Number(value)
  if (type === 'array' || type === 'object') return JSON.parse(String(value))
  return String(value)
}
function inputValue(type: InputType, value: string | boolean | undefined): string {
  if (type === 'boolean') return ''
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function PackageForm({ packageId, revision }: { packageId: string; revision: number }) {
  const result = useResource(signal => readPackage(packageId, revision, signal), null)
  const [draft, setDraft] = useState<Record<string, string | boolean> | null>(null)
  const [requestError, setRequestError] = useState('')
  const [createdId, setCreatedId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const requestIds = useRef(createRequestIds())
  const pkg = result.data
  const declarations = useMemo(() => Object.entries(pkg?.inputs || {}), [pkg])
  const defaults = useMemo(
    () => Object.fromEntries(declarations.map(([name, type]) => [name, type === 'boolean' ? false : ''])),
    [declarations],
  )
  const values = draft ?? defaults
  if (!pkg || result.loading || result.error) return <ResourceState loading={result.loading} error={result.error} onRetry={result.reload} />
  const setValue = (name: string, value: string | boolean) => {
    setDraft(previous => ({ ...(previous ?? defaults), [name]: value }))
    setRequestError(''); setCreatedId('')
  }
  async function submit() {
    if (submitting) return
    let input: Record<string, unknown>
    try {
      input = Object.fromEntries(declarations.map(([name, type]) => [name, parseValue(type, values[name] ?? '')]))
    } catch { setRequestError('输入材料必须是合法的 JSON。'); return }
    const payload = { package: packageId, revision, input }
    setSubmitting(true); setRequestError(''); setCreatedId('')
    try {
      const item = await createItem({ ...payload, requestId: requestIds.current(payload) }, new AbortController().signal)
      setCreatedId(item.id)
    } catch (cause) {
      setRequestError(errorMessage(cause))
    } finally { setSubmitting(false) }
  }
  return <section className="panel space-y-5 p-4 sm:p-5">
    <div><h2 className="text-lg font-semibold">{packageId} v{revision}</h2><p className="mt-1 whitespace-pre-wrap break-words text-sm text-txt2">{pkg.sop}</p></div>
    <dl className="grid gap-4 border-y border-line py-4 sm:grid-cols-2"><div><dt className="field-label">验收标准</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm">{pkg.acceptance}</dd></div><div><dt className="field-label">交付物</dt><dd className="mt-1 break-words text-sm">{pkg.deliverables?.join('、') || '未声明'}</dd></div></dl>
    {declarations.length > 0 ? <div className="space-y-4"><h3 className="font-semibold">本次材料</h3>{declarations.map(([name, type]) => <label className="field" key={name}><span className="field-label">{name} <span className="text-txt3">({type})</span></span>{type === 'boolean' ? <span className="flex items-center gap-2"><input type="checkbox" checked={Boolean(values[name])} onChange={event => setValue(name, event.target.checked)} />是</span> : type === 'object' || type === 'array' ? <Textarea aria-label={name} value={inputValue(type, values[name])} onChange={event => setValue(name, event.target.value)} rows={4} placeholder={type === 'array' ? '[ ]' : '{ }'} /> : <Input aria-label={name} type={type === 'number' || type === 'integer' ? 'number' : 'text'} value={inputValue(type, values[name])} onChange={event => setValue(name, event.target.value)} />}</label>)}</div> : <p className="text-sm text-txt2">此版本不要求额外材料。</p>}
    {requestError && <p role="alert" className="break-words text-sm text-err">{requestError} 请求标识已保留，重试不会重复创建相同工作项。</p>}
    {createdId ? <div className="flex flex-wrap items-center gap-3"><p className="text-sm text-ok">工作项已创建：{createdId}</p><Button variant="primary" asChild><Link to={`/items/${encodeURIComponent(createdId)}`}>打开工作项</Link></Button></div> : <Button variant="primary" loading={submitting} onClick={() => void submit}>创建待办理工作项</Button>}
  </section>
}
