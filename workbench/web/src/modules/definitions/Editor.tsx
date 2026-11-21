import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { errorMessage } from '@/shared/api'
import { Button } from '@/shared/ui/button'
import { ResourceState } from '@/shared/ui/resource-state'
import { PageHeader } from '@/shared/ui/page-header'
import { list, publish, readVersion, revisionPath, routePath, titles, type Collection, type Latest } from './catalog'
import { listConfigPackageChoices, type ConfigPackageChoice } from '@/modules/patches/api'
import { initialDraft, publishBody, type Draft } from './draft'
import { clearDraft, draftKey, readDraft, writeDraft } from './draft-store'
import { Choice, Hint, ResourceRefs, TextField } from './Fields'
import { AgentForm } from './AgentForm'
import { ConfigFields } from './ConfigFields'

type EditorProps = { k: Collection; id?: string; revision?: string }
export function Editor({ k, id, revision }: EditorProps) {
  const [params] = useSearchParams()
  const newAgent = k === 'executors' && !id && params.get('mode') === 'agent'
  return <EditorSource key={String(newAgent)} k={k} id={id} revision={revision} newAgent={newAgent} />
}
function EditorSource({ k, id, revision, newAgent }: EditorProps & { newAgent: boolean }) {
  const result = useResource(async signal => {
    const source = id ? await readVersion(k, id, revision, signal) : null
    const draft = initialDraft(source?.version)
    if (newAgent) draft.agent = { configPackageId: '' }
    const resources = k === 'executors' && !draft.agent ? await list('resources', signal) : []
    return { source, resources, draft }
  }, null)
  if (result.loading || !result.data || result.error) return <ResourceState {...result} onRetry={result.reload} />
  const { source, draft, resources } = result.data
  if (source && !source.latest.active) return <p role="status">对象已停用，不能发布新版，也不再接受新引用。 <Link to={revisionPath(k, source.version)}>返回版本详情</Link></p>
  return <EditorMode k={k} initial={draft} revision={source?.version.revision} storageKey={draftKey(k, id, revision)} resources={resources} />
}
type FormProps = { k: Collection; initial: Draft; revision?: number; storageKey: string; resources: Latest[] }
function EditorMode(props: FormProps) {
  const choose = props.k === 'executors' && !props.revision
  const initial = props.initial
  const agent = !!initial.agent
  const key = props.storageKey + (agent ? ':agent' : '')
  return <section className="page-stack max-w-4xl">
    <PageHeader title={`${props.revision ? '编辑' : '新建'}${titles[props.k]}`} description={props.revision ? `基于 ${initial.id} v${props.revision} 发布新版` : undefined} />
    {choose && <nav aria-label="配置方式" className="flex gap-2">
      <Button asChild variant={agent ? 'outline' : 'secondary'}><Link aria-current={!agent ? 'page' : undefined} to="/executors/new">通用配置</Link></Button>
      <Button asChild variant={agent ? 'secondary' : 'outline'}><Link aria-current={agent ? 'page' : undefined} to="/executors/new?mode=agent">基于 Agent 配置</Link></Button>
    </nav>}
    <EditForm key={key} {...props} storageKey={key} initial={initial} />
  </section>
}
function EditForm({ k, initial, revision, storageKey, resources }: FormProps) {
  const navigate = useNavigate()
  const [restored, setRestored] = useState<Draft | null>(() => readDraft(storageKey))
  const [d, setDraft] = useState<Draft>(() => restored ?? initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const needsConfigPackages = !d.agent && d.configSchema.fields.some(field => field.type === 'configPackage')
  const configPackages = useResource(signal => needsConfigPackages ? listConfigPackageChoices(signal) : Promise.resolve([] as ConfigPackageChoice[]), [] as ConfigPackageChoice[])
  const mounted = useRef(false)
  const published = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  // 与原文一致的草稿不算改动，只在本机保存真正填写过的内容，供补建依赖后回到本页继续。
  useEffect(() => {
    if (published.current) return
    if (JSON.stringify(d) === JSON.stringify(initial)) clearDraft(storageKey)
    else writeDraft(storageKey, d)
  }, [d, initial, storageKey])
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(old => ({ ...old, [key]: value }))
  function discard() {
    clearDraft(storageKey); setRestored(null); setDraft(initial); setError('')
  }
  async function submit() {
    if (busy) return
    setBusy(true); setError('')
    let body: unknown
    try { body = publishBody(k, d) } catch (err) { setError(errorMessage(err)); setBusy(false); return }
    try {
      const v = await publish(k, body)
      published.current = true
      clearDraft(storageKey)
      if (mounted.current) await navigate(revisionPath(k, v))
    } catch (err) { if (mounted.current) setError(errorMessage(err)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const title = titles[k]
  const cancel = <Button asChild><Link to={revision ? revisionPath(k, { id: initial.id, revision }) : routePath(k)}>返回{revision ? '版本详情' : '目录'}</Link></Button>
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void submit() }
  return <div className="page-stack">
    {restored && <div role="status" className="flex flex-wrap items-center gap-2 border-l-2 border-accent-2 pl-3">
      <p className="text-sm">已恢复上次在本机保存的未发布草稿，草稿只存在当前浏览器，尚未提交。</p>
      <Button onClick={discard}>放弃草稿并重新填写</Button>
    </div>}
    {d.agent && k === 'executors' ? <AgentForm draft={{ ...d, agent: d.agent }} revision={revision} busy={busy} change={change} publish={submit} cancel={cancel} /> : <form className="page-stack" onSubmit={onSubmit}>
    <fieldset disabled={busy} className="min-w-0 space-y-5">
      <TextField label={`${title} ID`} value={d.id} change={v => change('id', v)} required readOnly={!!revision} />
      {k === 'resources' && <>
        <Choice label="资源类型" value={d.resourceKind} change={v => change('resourceKind', v)} options={[["skill", "Skill"], ["prompt", "提示词"], ["mcp", "MCP 引用"]]} />
        {d.resourceKind === 'mcp' ? <>
          <Hint>MCP 只登记服务与凭据的命名引用，连接参数和凭据由管理员管理；本页不提供注入设置，当前执行后端也不支持运行时注入，因此不能绑定到执行器。</Hint>
          <TextField label="服务引用" value={d.serverRef} change={v => change('serverRef', v)} required />
          <TextField label="凭据引用（可选）" value={d.credentialRef} change={v => change('credentialRef', v)} />
        </> : <TextField label="资源内容" value={d.text} change={v => change('text', v)} multiline required />}
        <Hint>{d.resourceKind === 'skill' ? 'Skill 按纯文本发布，使用它的执行器固定这一版本。' : d.resourceKind === 'prompt' ? '提示词按纯文本发布，被执行器引用时固定这一版本。' : '已有执行器若引用了 MCP 版本，绑定会在目录中显示为不可执行。'}</Hint>
      </>}
      {k === 'executors' && <>
        <section className="space-y-3 border-y border-line py-4" aria-labelledby="executor-contract">
          <div><h2 id="executor-contract" className="font-semibold">执行契约</h2>
            <p className="mt-1 text-sm text-txt3">平台为每次执行提供工作区和冻结的工作指令，执行器完成工作后写入独立的制品目录。</p></div>
          <p className="font-mono text-sm">workspace + workInstruction → artifactDirectory</p>
          <p className="text-sm text-txt3">平台记录日志和执行器记录日志都会保存在执行详情中，日志查看器暂未实现。</p>
        </section>
        <ResourceRefs label="执行器资源" choices={resources} value={d.resources} change={v => change('resources', v)} />
        <Hint>执行器引用所选的资源版本。执行程序、工作目录、环境变量和命令由服务端管理。</Hint>
        {d.configSchema.fields.length > 0 && <ConfigFields schema={d.configSchema} values={d.config} packageChoices={configPackages.data}
          packageLoading={needsConfigPackages && configPackages.loading} packageError={needsConfigPackages ? configPackages.error : ''} onReloadPackages={configPackages.reload}
          onValueChange={() => {}} readOnly />}
      </>}
    </fieldset>
    <div className="flex flex-wrap gap-2"><Button type="submit" variant="primary" loading={busy}>发布{revision ? '新版' : title}</Button>
      {cancel}</div>
    </form>}
    {error && <p role="alert" className="text-err">{error}</p>}
  </div>
}
