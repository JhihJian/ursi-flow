import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { errorMessage } from '@/shared/api'
import { Button } from '@/shared/ui/button'
import { ResourceState } from '@/shared/ui/resource-state'
import { PageHeader } from '@/shared/ui/page-header'
import { boundExecutors, list, publish, readVersion, revisionPath, titles, type Collection, type Latest } from './catalog'
import { blankAction, initialDraft, publishBody, type ActionDraft, type Draft } from './draft'
import { Choice, PortsEditor, RefPicker, ResourceRefs, TextField } from './Fields'

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
  if (source && !source.latest.active) return <p role="status">对象已停用，不能发布新版。 <Link to={revisionPath(k, source.version)}>返回版本详情</Link></p>
  return <EditForm k={k} initial={draft} revision={source?.version.revision} resources={resources} executors={executors} />
}
function EditForm({ k, initial, revision, resources, executors }: {
  k: Collection; initial: Draft; revision?: number; resources: Latest[]; executors: Latest[]
}) {
  const navigate = useNavigate()
  const [d, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const review = Boolean(revision && k === 'packages')
  const [reviewed, setReviewed] = useState(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(old => ({ ...old, [key]: value }))
  const action = (i: number, patch: Partial<ActionDraft>) => change('actions', d.actions.map((v, n) => n === i ? { ...v, ...patch } : v))
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || (review && !reviewed)) return
    setBusy(true); setError('')
    try {
      const v = await publish(k, publishBody(k, d))
      if (mounted.current) await navigate(revisionPath(k, v))
    } catch (err) { if (mounted.current) setError(errorMessage(err)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const title = titles[k]
  return <form className="page-stack max-w-4xl" onSubmit={submit}>
    <PageHeader title={`${revision ? '编辑' : '新建'}${title}`} description={revision ? `基于 ${initial.id} v${revision} 发布新版` : undefined} />
    <fieldset disabled={busy} className="min-w-0 space-y-5">
      <TextField label={`${title} ID`} value={d.id} change={v => change('id', v)} required readOnly={!!revision} />
      {k === 'resources' && <>
        <Choice label="资源类型" value={d.resourceKind} change={v => change('resourceKind', v)} options={[["skill", "Skill"], ["prompt", "提示词"], ["mcp", "MCP 引用"]]} />
        {d.resourceKind === 'mcp' ? <>
          <TextField label="服务引用" value={d.serverRef} change={v => change('serverRef', v)} required />
          <TextField label="凭据引用（可选）" value={d.credentialRef} change={v => change('credentialRef', v)} />
        </> : <TextField label="资源内容" value={d.text} change={v => change('text', v)} multiline required />}
      </>}
      {k === 'executors' && <>
        <Choice label="执行器类型" value={d.executorKind} change={v => change('executorKind', v)} options={[["agent", "Agent"], ["flow", "Agent Flow"]]} />
        {d.executorKind === 'agent' ? <>
          <Choice label="执行环境" value={d.environment} change={v => change('environment', v)} options={[["", "默认（本地）"], ["local", "本地"], ["sandbox", "预配沙箱"]]} />
          <ResourceRefs label="执行器资源" choices={resources} value={d.resources} change={v => change('resources', v)} />
        </> : <><TextField label="Flow ID" value={d.flowId} change={v => change('flowId', v)} required />
          <TextField label="Flow 目录修订" value={d.flowRevision} change={v => change('flowRevision', v)} required /></>}
      </>}
      {k === 'packages' && <>
        <TextField label={d.structuredGoal ? '目标（结构化 JSON）' : '目标'} value={d.goal ?? ''} change={v => change('goal', v)} multiline={d.structuredGoal} />
        <TextField label="SOP" value={d.sop} change={v => change('sop', v)} required multiline />
        <TextField label="验收标准" value={d.acceptance} change={v => change('acceptance', v)} required multiline />
        <TextField label="交付物文件名（每行一个）" value={d.deliverables ?? ''} change={v => change('deliverables', v)} multiline />
        <ResourceRefs label="工作包资源" choices={resources} value={d.resources} change={v => change('resources', v)} />
      </>}
      {k !== 'resources' && <div className="grid gap-4 md:grid-cols-2">
        <PortsEditor label="输入" value={d.inputs} change={v => change('inputs', v)} />
        <PortsEditor label="输出" value={d.outputs} change={v => change('outputs', v)} />
      </div>}
      {k === 'packages' && <section className="space-y-4"><h2 className="font-semibold">动作绑定</h2>
        {d.actions.map((a, i) => <fieldset className="min-w-0 space-y-3 border-t border-line pt-2" key={i}><legend>动作 {i + 1}</legend>
          <TextField label="动作名称" value={a.name} change={name => action(i, { name })} required />
          <RefPicker k="executors" choices={executors} value={a.executor} change={executor => action(i, { executor })} />
          <ResourceRefs label="动作资源" choices={resources} value={a.resources} change={value => action(i, { resources: value })} />
          <div className="grid gap-4 md:grid-cols-2"><PortsEditor label="动作输入" value={a.inputs} change={inputs => action(i, { inputs })} override />
            <PortsEditor label="动作输出" value={a.outputs} change={outputs => action(i, { outputs })} override /></div>
          {d.actions.length > 1 && <Button onClick={() => change('actions', d.actions.filter((_, n) => n !== i))}>移除动作</Button>}
        </fieldset>)}<Button onClick={() => change('actions', [...d.actions, blankAction()])}>添加动作</Button>
      </section>}
      {review && <section className="space-y-2 border-l-2 border-warn pl-3"><h2 className="font-semibold">发布前核对动作</h2>
        <p>旧版本只保留合并后的资源。草稿把包和执行器已提供的资源作为继承项，无法识别动作是否也重复引用。动作单独声明的输入输出未保存在快照中，当前默认继承包声明。请按原要求补全。</p>
        <Link className="text-accent-2" to={revisionPath(k, { id: initial.id, revision: revision! })} target="_blank" rel="noreferrer">在新窗口查看原版本</Link>
        <label className="flex items-center gap-2"><input type="checkbox" required checked={reviewed} onChange={e => setReviewed(e.target.checked)} />我已核对动作资源和输入输出声明</label>
      </section>}
    </fieldset>
    {error && <p role="alert" className="text-err">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button type="submit" variant="primary" loading={busy} disabled={review && !reviewed}>发布{revision ? '新版' : title}</Button>
      <Button asChild><Link to={revision ? revisionPath(k, { id: initial.id, revision }) : `/${k}`}>取消</Link></Button></div>
  </form>
}
