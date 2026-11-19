import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { errorMessage } from '@/shared/api'
import { Button } from '@/shared/ui/button'
import { ResourceState } from '@/shared/ui/resource-state'
import { PageHeader } from '@/shared/ui/page-header'
import { boundExecutors, list, publish, readVersion, revisionPath, routePath, sameRef, sopLabel, titles, type Collection, type Latest } from './catalog'
import { listConfigPackageChoices, type ConfigPackageChoice } from '@/modules/patches/api'
import { blankAction, initialDraft, publishBody, type ActionDraft, type Draft } from './draft'
import { clearDraft, draftKey, readDraft, writeDraft } from './draft-store'
import { Choice, Hint, PortsEditor, RefPicker, ResourceRefs, TextField } from './Fields'
import { ConfigFields } from './ConfigFields'

type EditorProps = { k: Collection; id?: string; revision?: string }
export function Editor({ k, id, revision }: EditorProps) {
  const result = useResource(async signal => {
    const [source, resources, executors] = await Promise.all([
      id ? readVersion(k, id, revision, signal) : null,
      k !== 'resources' ? list('resources', signal) : [],
      k === 'packages' ? list('executors', signal) : [],
    ])
    const v = source?.version
    const bindings = v && 'actions' in v ? await boundExecutors(v, signal) : []
    return { source, resources, executors, draft: initialDraft(v, bindings) }
  }, null)
  if (result.loading || !result.data || result.error) return <ResourceState {...result} onRetry={result.reload} />
  const { source, draft, resources, executors } = result.data
  if (source && !source.latest.active) return <p role="status">对象已停用，不能发布新版，也不再接受新派工和新引用。 <Link to={revisionPath(k, source.version)}>返回版本详情</Link></p>
  return <EditForm k={k} initial={draft} revision={source?.version.revision} storageKey={draftKey(k, id, revision)} resources={resources} executors={executors} />
}
function EditForm({ k, initial, revision, storageKey, resources, executors }: {
  k: Collection; initial: Draft; revision?: number; storageKey: string; resources: Latest[]; executors: Latest[]
}) {
  const navigate = useNavigate()
  const [restored, setRestored] = useState<Draft | null>(() => readDraft(storageKey))
  const [d, setDraft] = useState<Draft>(() => restored ?? initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const needsConfigPackages = d.configSchema.fields.some(field => field.type === 'configPackage') || (k === 'packages' && d.actions.some(action => {
    const executor = executors.find(candidate => sameRef(candidate, action.executor))
    const schema = executor && !('content' in executor) && !('actions' in executor) ? executor.configSchema : undefined
    return schema?.fields.some(field => field.type === 'configPackage') ?? false
  }))
  const configPackages = useResource(signal => needsConfigPackages ? listConfigPackageChoices(signal) : Promise.resolve([] as ConfigPackageChoice[]), [] as ConfigPackageChoice[])
  const review = Boolean(revision && k === 'packages')
  const [reviewed, setReviewed] = useState(false)
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
  const action = (i: number, patch: Partial<ActionDraft>) => change('actions', d.actions.map((v, n) => n === i ? { ...v, ...patch } : v))
  function discard() {
    clearDraft(storageKey); setRestored(null); setDraft(initial); setError('')
  }
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || (review && !reviewed)) return
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
  const noActiveExecutor = k === 'packages' && !executors.some(v => v.active)
  return <form className="page-stack max-w-4xl" onSubmit={submit}>
    <PageHeader title={`${revision ? '编辑' : '新建'}${title}`} description={revision ? `基于 ${initial.id} v${revision} 发布新版` : undefined} />
    {restored && <div role="status" className="flex flex-wrap items-center gap-2 border-l-2 border-accent-2 pl-3">
      <p className="text-sm">已恢复上次在本机保存的未发布草稿，草稿只存在当前浏览器，尚未提交。</p>
      <Button onClick={discard}>放弃草稿并重新填写</Button>
    </div>}
    <fieldset disabled={busy} className="min-w-0 space-y-5">
      <TextField label={`${title} ID`} value={d.id} change={v => change('id', v)} required readOnly={!!revision} />
      {k === 'resources' && <>
        <Choice label="资源类型" value={d.resourceKind} change={v => change('resourceKind', v)} options={[["skill", "Skill"], ["prompt", "提示词"], ["mcp", "MCP 引用"]]} />
        {d.resourceKind === 'mcp' ? <>
          <Hint>MCP 只登记服务与凭据的命名引用，连接参数和凭据由管理员管理；本页不提供注入设置，当前执行后端也不支持运行时注入，因此不能绑定到执行器或派工模板。</Hint>
          <TextField label="服务引用" value={d.serverRef} change={v => change('serverRef', v)} required />
          <TextField label="凭据引用（可选）" value={d.credentialRef} change={v => change('credentialRef', v)} />
        </> : <TextField label="资源内容" value={d.text} change={v => change('text', v)} multiline required />}
        <Hint>{d.resourceKind === 'skill' ? 'Skill 按纯文本发布，使用它的执行器固定这一版本。' : d.resourceKind === 'prompt' ? '提示词按纯文本发布，被 Agent 或派工模板引用时固定这一版本。' : '已有执行器若引用了 MCP 版本，绑定会在目录中显示为不可执行。'}</Hint>
      </>}
      {k === 'executors' && <>
        <section className="space-y-3 border-y border-line py-4" aria-labelledby="executor-contract">
          <div><h2 id="executor-contract" className="font-semibold">执行契约</h2>
            <p className="mt-1 text-sm text-txt3">平台为每次执行提供工作区和冻结的工作指令，执行器完成工作后写入独立的制品目录。</p></div>
          <p className="font-mono text-sm">workspace + workInstruction → artifactDirectory</p>
          <p className="text-sm text-txt3">平台记录日志和执行器记录日志都会保存在执行详情中，日志查看器暂未实现。</p>
        </section>
        <ResourceRefs label="执行器资源" choices={resources} value={d.resources} change={v => change('resources', v)} />
        <Hint>资源按固定版本冻结到派工快照。执行程序、工作目录、环境变量和命令由服务端管理。</Hint>
        {d.configSchema.fields.length > 0 && <ConfigFields schema={d.configSchema} values={d.config} packageChoices={configPackages.data}
          packageLoading={needsConfigPackages && configPackages.loading} packageError={needsConfigPackages ? configPackages.error : ''} onReloadPackages={configPackages.reload}
          onValueChange={() => {}} readOnly />}
      </>}
      {k === 'packages' && <>
        <TextField label={d.structuredGoal ? '目标（结构化 JSON）' : '目标'} value={d.goal ?? ''} change={v => change('goal', v)} multiline={d.structuredGoal} />
        <TextField label={sopLabel} value={d.sop} change={v => change('sop', v)} required multiline />
        <TextField label="验收标准" value={d.acceptance} change={v => change('acceptance', v)} required multiline />
        <TextField label="必交文件（每行一个文件名）" value={d.deliverables ?? ''} change={v => change('deliverables', v)} multiline />
        <ResourceRefs label="派工模板资源" choices={resources} value={d.resources} change={v => change('resources', v)} />
        <Hint>派工模板资源对该模板所有动作生效，发布时与动作资源按固定版本合并。</Hint>
      </>}
      {k === 'packages' && <div className="grid gap-4 md:grid-cols-2">
        <PortsEditor label="输入" value={d.inputs} change={v => change('inputs', v)} />
        <PortsEditor label="输出" value={d.outputs} change={v => change('outputs', v)} />
      </div>}
      {k === 'packages' && <section className="space-y-4"><h2 className="font-semibold">动作绑定</h2>
        {needsConfigPackages && configPackages.loading && <p role="status" className="text-sm text-txt3">正在读取配置包…</p>}
        {needsConfigPackages && configPackages.error && <p role="alert" className="text-sm text-err">配置包列表读取失败：{configPackages.error}</p>}
        {noActiveExecutor && <Hint>还没有可用执行器，可以先到执行器目录补建依赖：<Link className="text-accent-2" to="/executors/new">补建执行器</Link>。已填写的内容保存在当前浏览器，回来后可用原草稿继续。</Hint>}
        {d.actions.map((a, i) => <fieldset className="min-w-0 space-y-3 border-t border-line pt-2" key={i}><legend>动作 {i + 1}</legend>
          <TextField label="动作名称" value={a.name} change={name => action(i, { name })} required />
          <RefPicker k="executors" choices={executors} value={a.executor} change={executor => action(i, { executor })} />
          {(() => {
            const executor = executors.find(candidate => sameRef(candidate, a.executor))
            const schema = executor && !('content' in executor) && !('actions' in executor) ? executor.configSchema : undefined
            return schema?.fields.some(field => field.type === 'configPackage')
          })() && <Choice
            label="配置包"
            value={a.configPackage ?? ''}
            change={configPackage => action(i, { configPackage: configPackage || undefined })}
            options={configPackages.data.map(packageChoice => [packageChoice.id, packageChoice.name] as [string, string])}
          />}
          <ResourceRefs label="动作资源" choices={resources} value={a.resources} change={value => action(i, { resources: value })} />
          <div className="grid gap-4 md:grid-cols-2"><PortsEditor label="动作输入" value={a.inputs} change={inputs => action(i, { inputs })} override />
            <PortsEditor label="动作输出" value={a.outputs} change={outputs => action(i, { outputs })} override /></div>
          {review && <Hint>旧快照不含本动作原来的输入输出声明。下面默认继承派工模板，如果原要求单独声明，请勾选后重填；资源也只保留能追溯到动作的部分。</Hint>}
          {d.actions.length > 1 && <Button onClick={() => change('actions', d.actions.filter((_, n) => n !== i))}>移除动作</Button>}
        </fieldset>)}<Button onClick={() => change('actions', [...d.actions, blankAction()])}>添加动作</Button>
      </section>}
      {review && <section className="space-y-2 border-l-2 border-warn pl-3"><h2 className="font-semibold">发布前核对动作</h2>
        <p>旧版本只保留合并后的资源。草稿把包和执行器已提供的资源作为继承项，无法识别同一版本是否也由动作重复引用。动作单独声明的输入输出未保存在快照中，当前按继承处理。请逐动作核对，发布时不会替你恢复这些信息。</p>
        <Link className="text-accent-2" to={revisionPath(k, { id: initial.id, revision: revision! })} target="_blank" rel="noreferrer">在新窗口查看原版本</Link>
        <label className="flex items-center gap-2"><input type="checkbox" required checked={reviewed} onChange={e => setReviewed(e.target.checked)} />我已核对动作资源和输入输出声明</label>
      </section>}
    </fieldset>
    {error && <p role="alert" className="text-err">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button type="submit" variant="primary" loading={busy} disabled={review && !reviewed}>发布{revision ? '新版' : title}</Button>
      <Button asChild><Link to={revision ? revisionPath(k, { id: initial.id, revision }) : routePath(k)}>取消</Link></Button></div>
  </form>
}
