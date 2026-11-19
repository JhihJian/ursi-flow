import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { errorMessage } from '@/shared/api'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { executorIds, executorInfo, findVersion, historyPath, listSops, publishSop, revisionPath, sopTitle, validateDraft, type SopExecutorId, type SopVersion } from './model'

export function SopEditor() {
  const { id, revision } = useParams()
  const source = useResource(
    signal => id ? listSops(signal) : Promise.resolve([] as SopVersion[]),
    [] as SopVersion[],
  )
  if (!id) return <SopForm />
  if (source.loading || source.error) return <div className="page-stack">
    <ResourceState loading={source.loading} error={source.error} onRetry={source.reload} />
  </div>
  const base = findVersion(source.data, id, revision ?? '')
  if (!base) return <div className="page-stack break-words">
    <PageHeader title="未找到要基于的 SOP 修订" description={`${id} v${revision}`} />
    <ResourceState empty title="未找到该 SOP 修订" description="不能基于不存在的修订发布新版，请回到修订列表重新选择。">
      <Button asChild><Link to={historyPath(id)}>查看该 SOP 的修订</Link></Button>
    </ResourceState>
  </div>
  return <SopForm base={base} />
}

function SopForm({ base }: { base?: SopVersion }) {
  const navigate = useNavigate()
  const [id, setId] = useState(base?.id ?? '')
  const [executor, setExecutor] = useState<SopExecutorId>(
    base && executorIds.some(value => value === base.executor) ? base.executor as SopExecutorId : 'echo',
  )
  const [title, setTitle] = useState(base ? sopTitle(base) : '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const info = executorInfo(executor)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const trimmedId = id.trim()
    const invalid = validateDraft(trimmedId, title)
    if (invalid) { setError(invalid); return }
    setBusy(true)
    setError('')
    try {
      const created = await publishSop({ id: trimmedId, executor, config: { title: title.trim() } })
      await navigate(revisionPath(created))
    } catch (cause) {
      if (mounted.current) {
        setError(errorMessage(cause))
        setBusy(false)
      }
    }
  }

  return <form className="page-stack max-w-2xl break-words" onSubmit={submit}>
    <PageHeader title={base ? '从该版发布新版' : '发布 SOP'}
      description={base ? `基于 ${base.id} v${base.revision} 追加新修订` : '创建一个带固定修订的 SOP，供工作区绑定'} />
    <fieldset disabled={busy} className="panel space-y-5 p-4 sm:p-5">
      <label className="field">
        <span className="field-label">SOP 标识</span>
        <Input aria-label="SOP 标识" value={id} readOnly={Boolean(base)}
          onChange={event => { setId(event.target.value); setError('') }} />
        <span className="text-xs text-txt3">
          {base ? '标识来自正在阅读的修订，新版沿用同一个 SOP。' : '使用字母、数字、短横线或下划线，最多 80 个字符；发布后标识不会改变。'}
        </span>
      </label>
      <label className="field">
        <span className="field-label">执行器</span>
        <Select aria-label="执行器" value={executor} onChange={event => setExecutor(event.target.value as SopExecutorId)}>
          {executorIds.map(value => <option key={value} value={value}>{executorInfo(value).name}</option>)}
        </Select>
        <span className="text-xs text-txt3">{info.hint}</span>
      </label>
      <label className="field">
        <span className="field-label">回执标题</span>
        <Input aria-label="回执标题" value={title} placeholder="例如：项目交接记录"
          onChange={event => { setTitle(event.target.value); setError('') }} />
        <span className="text-xs text-txt3">{info.titleHint}</span>
      </label>
      {error && <p role="alert" className="break-words text-sm text-err">{error} 已填写的内容仍然保留。</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" loading={busy}>{base ? '发布新版' : '发布 SOP'}</Button>
        <Button asChild><Link to={base ? revisionPath(base) : '/sops'}>{base ? `返回 v${base.revision}` : '返回 SOP 目录'}</Link></Button>
        <p className="text-xs text-txt3">发布后生成新的冻结修订，旧修订保持不变。</p>
      </div>
    </fieldset>
  </form>
}
