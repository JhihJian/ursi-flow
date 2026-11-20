import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { errorMessage } from '@/shared/api'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { Textarea } from '@/shared/ui/textarea'
import { createRequestIds, useDispatch } from './dispatch'
import { declarationsOf, initialDraft, parseDeclared, placeholderOf, type Draft } from './input'
import {
  createItem, itemPath, readPackages, readRevisions, type InputType, type WorkPackage,
} from './model'

/** 深链里的修订号只在是正整数时才参与选择，0 和非法值退回该包的最新版。 */
function revisionOf(params: URLSearchParams) {
  const value = Number(params.get('revision') ?? '')
  return Number.isInteger(value) && value > 0 ? value : 0
}

export function StartWork() {
  const [params, setParams] = useSearchParams()
  const catalog = useResource(readPackages, [])
  const dispatchable = catalog.data.filter(item => item.active)
  const requested = params.get('package') ?? ''
  const known = requested ? catalog.data.find(item => item.id === requested) : undefined
  const selected = requested ? dispatchable.find(item => item.id === requested) : dispatchable[0]
  const loaded = !catalog.loading && !catalog.error
  // 目录没读到时不能断言包不存在，避免把故障说成停用或缺失。
  const blocked = loaded && requested && !selected ? (known ? '停用' : '不存在') : ''

  const choose = (id: string, revision?: number) => {
    const next = new URLSearchParams({ package: id })
    if (revision) next.set('revision', String(revision))
    setParams(next, { replace: true })
  }

  return <div className="page-stack break-words">
    <PageHeader title="发起工作" description="选择已发布的派工模板版本，按声明填写材料后创建一张待办理工作项"
      actions={<Button asChild><Link to="/items">返回派工记录</Link></Button>} />
    <ResourceState loading={catalog.loading && catalog.data.length === 0} error={catalog.error}
      empty={!catalog.loading && !catalog.error && dispatchable.length === 0 && !blocked}
      title={catalog.error ? undefined : '暂无可用派工模板'}
      description={catalog.error ? undefined : '请联系管理员发布或检查派工模板。'}
      onRetry={catalog.reload} />
    {blocked && <section className="panel space-y-3 p-4 sm:p-5" role="alert">
      <h2 className="font-semibold text-txt">无法从该版本发起工作</h2>
      <p className="break-words text-sm text-txt2">派工模板 {requested} {blocked}，不能用于新的派工。已发出的工作项仍可在清单里查看。</p>
    </section>}
    {dispatchable.length > 0 && <section className="panel space-y-4 p-4 sm:p-5">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <label className="field"><span className="field-label">派工模板</span>
          <Select aria-label="派工模板" value={selected?.id ?? ''} onChange={event => choose(event.target.value)}>
            {!selected && <option value="">选择其他派工模板</option>}
            {dispatchable.map(item => <option key={item.id} value={item.id}>{item.id} · 最新 v{item.revision}</option>)}
          </Select>
        </label>
      </div>
    </section>}
    {selected && <VersionPicker key={selected.id} packageId={selected.id} requestedRevision={revisionOf(params)}
      onRevision={revision => choose(selected.id, revision)} />}
  </div>
}

/** 修订列表决定可选版本；深链指向的版本在列表里就用它，否则用最新版。 */
function VersionPicker({ packageId, requestedRevision, onRevision }: {
  packageId: string
  requestedRevision: number
  onRevision: (revision: number) => void
}) {
  const revisions = useResource(signal => readRevisions(packageId, signal), [])
  const versions = revisions.data
  const revision = versions.some(item => item.revision === requestedRevision) ? requestedRevision : versions.at(-1)?.revision
  const current = versions.find(item => item.revision === revision)
  if (revisions.error) return <ResourceState error={revisions.error} onRetry={revisions.reload} />
  if (revisions.loading) return <ResourceState loading />
  if (!current || !revision) return <ResourceState empty title="该派工模板没有可派工的版本"
    description="请联系管理员检查该模板的修订。" />
  return <PackageForm key={`${packageId}:${revision}`} packageId={packageId} pkg={current} revision={revision}
    versions={versions.map(item => item.revision)} onRevision={onRevision} />
}

function PackageForm({ packageId, pkg, revision, versions, onRevision }: {
  packageId: string
  pkg: WorkPackage
  revision: number
  versions: number[]
  onRevision: (revision: number) => void
}) {
  const navigate = useNavigate()
  const declarations = useMemo(() => declarationsOf(pkg.inputs), [pkg.inputs])
  const [draft, setDraft] = useState<Draft>(() => initialDraft(declarations))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [requestError, setRequestError] = useState('')
  const requestIds = useRef(createRequestIds())
  const dispatch = useDispatch()
  const values = { ...initialDraft(declarations), ...draft }

  const setValue = (name: string, value: string | boolean) => {
    setDraft(previous => ({ ...previous, [name]: value }))
    setErrors(previous => (previous[name] ? { ...previous, [name]: '' } : previous))
    setRequestError('')
  }

  async function submit() {
    const parsed = parseDeclared(declarations, values)
    setErrors(parsed.errors)
    if (!parsed.valid) { setRequestError(''); return }
    const parameters = { package: packageId, revision, input: parsed.input }
    setRequestError('')
    await dispatch.run(
      signal => createItem({ ...parameters, requestId: requestIds.current(parameters) }, signal),
      id => navigate(itemPath(id)),
      cause => setRequestError(errorMessage(cause)),
    )
  }

  return <section className="panel space-y-5 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="break-all text-lg font-semibold">{packageId} v{revision}</h2>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-txt2">{pkg.sop}</p>
      </div>
      {versions.length > 1 && <label className="field w-32"><span className="field-label">修订版本</span>
        <Select aria-label="修订版本" value={revision} onChange={event => onRevision(Number(event.target.value))}>
          {versions.map(item => <option key={item} value={item}>{revision === item ? `v${item} · 当前` : `v${item}`}</option>)}
        </Select>
      </label>}
    </div>
    <dl className="grid gap-4 border-y border-line py-4 sm:grid-cols-2">
      <div><dt className="field-label">验收标准</dt>
        <dd className="mt-1 whitespace-pre-wrap break-words text-sm">{pkg.acceptance}</dd></div>
      <div><dt className="field-label">交付物</dt>
        <dd className="mt-1 break-words text-sm">{pkg.deliverables?.join('、') || '未声明'}</dd></div>
    </dl>
    {declarations.length > 0 ? <div className="space-y-4">
      <h3 className="font-semibold text-txt">本次材料</h3>
      {declarations.map(([name, type]) => <Field key={name} name={name} type={type} value={values[name]}
        error={errors[name]} onChange={value => setValue(name, value)} />)}
    </div> : <p className="text-sm text-txt2">此版本不要求额外材料。</p>}
    {requestError && <p role="alert" className="break-words text-sm text-err">{requestError} 表单内容已保留，可直接重试。</p>}
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" loading={dispatch.busy} onClick={() => void submit()}>创建待办理工作项</Button>
      <p className="text-xs text-txt3">只创建单据，执行由详情页发起。</p>
    </div>
  </section>
}

function Field({ name, type, value, error, onChange }: {
  name: string
  type: InputType
  value: string | boolean | undefined
  error?: string
  onChange: (value: string | boolean) => void
}) {
  const text = typeof value === 'string' ? value : ''
  const invalid = Boolean(error)
  const label = <span className="field-label">{name} <span className="text-txt3">({type})</span></span>
  if (type === 'boolean') {
    return <label className="field">
      {label}
      <span className="flex items-center gap-2 text-sm">
        <input type="checkbox" aria-label={name} checked={value === true}
          onChange={event => onChange(event.target.checked)} />
        {value === true ? '是' : '否'}
      </span>
      {error && <span className="text-sm text-err">{error}</span>}
    </label>
  }
  return <label className="field">
    {label}
    {type === 'object' || type === 'array'
      ? <Textarea aria-label={name} aria-invalid={invalid} value={text} rows={4}
        placeholder={placeholderOf(type)} onChange={event => onChange(event.target.value)} />
      : <Input aria-label={name} aria-invalid={invalid} inputMode={type === 'number' || type === 'integer' ? 'decimal' : undefined}
        value={text} placeholder={placeholderOf(type)} onChange={event => onChange(event.target.value)} />}
    {error && <span className="text-sm text-err">{error}</span>}
  </label>
}
