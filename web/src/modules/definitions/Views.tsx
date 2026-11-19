import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '@/shared/api'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Modal } from '@/shared/ui/modal'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Choice } from './Fields'
import { deactivate, history, kindNames, list, objectPath, readVersion, revisionPath, titles, type Collection, type Definition, type Ref, type Target } from './catalog'

function VersionLink({ k, v }: { k: Collection; v: Ref }) {
  return <Link className="break-all font-medium text-accent-2 hover:underline" to={revisionPath(k, v)}>{v.id} v{v.revision}</Link>
}
export function Directory({ k }: { k: Collection }) {
  const name = titles[k]
  const result = useResource(signal => list(k, signal), [])
  const [filter, setFilter] = useState('')
  const items = result.data.filter(v => !filter || ('kind' in v && v.kind === filter))
  return <section className="page-stack"><PageHeader title={k === 'resources' ? '资源库' : name} actions={<Button variant="primary" asChild><Link to={`/${k}/new`}>新建{name}</Link></Button>} />
    {k === 'resources' && <div className="max-w-xs"><Choice label="资源类型筛选" value={filter} change={setFilter} options={[["", "全部"], ["skill", "Skill"], ["prompt", "提示词"], ["mcp", "MCP 引用"]]} /></div>}
    {result.loading || result.error || !items.length ? <ResourceState loading={result.loading} error={result.error} empty title={result.error ? undefined : `暂无${name}`} onRetry={result.reload} /> :
      <ul className="divide-y divide-line border-y border-line">{items.map(v => <li key={v.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
        <VersionLink k={k} v={v} />{'kind' in v && <span>{kindNames[v.kind]}</span>}<span className="ml-auto text-txt3">{v.active ? '已启用' : '已停用'}</span>
      </li>)}</ul>}
  </section>
}
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="field-label">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{children}</dd></div>
}
function Resources({ refs }: { refs?: Ref[] }) {
  return refs?.length ? <ul>{refs.map((v, n) => <li key={n}><VersionLink k="resources" v={v} /></li>)}</ul> : '无'
}
function show(v: unknown) { return typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '未声明' }
function ExecutionTarget({ target }: { target: Target }) {
  return target.kind === 'flow' ? <><Fact label="Flow ID"><Link className="text-accent-2" to={`/flows/${encodeURIComponent(target.flowId!)}/edit`}>{target.flowId}</Link></Fact>
    <Fact label="固定目录修订">{target.flowRevision}</Fact></> : <Fact label="执行环境">{target.environment === 'sandbox' ? '预配沙箱' : '本地'}</Fact>
}
function VersionBody({ v }: { v: Definition }) {
  if ('content' in v) return <dl className="space-y-4"><Fact label="类型">{kindNames[v.kind]}</Fact>{typeof v.content === 'string'
    ? <Fact label="资源内容">{v.content}</Fact> : <><Fact label="服务引用">{v.content.serverRef}</Fact><Fact label="凭据引用">{v.content.credentialRef || '无'}</Fact></>}</dl>
  const io = <div className="grid gap-4 sm:grid-cols-2"><Fact label="输入声明">{show(v.inputs)}</Fact><Fact label="输出声明">{show(v.outputs)}</Fact></div>
  if ('kind' in v) return <dl className="space-y-4"><Fact label="类型">{kindNames[v.kind]}</Fact><ExecutionTarget target={v} />
    <Fact label="资源依赖"><Resources refs={v.resources} /></Fact>{io}</dl>
  return <><dl className="space-y-4"><Fact label="目标">{show(v.goal)}</Fact><Fact label="SOP">{v.sop}</Fact>
    <Fact label="验收标准">{v.acceptance}</Fact><Fact label="交付物">{v.deliverables?.join('\n') || '未声明'}</Fact>{io}
    <Fact label="工作包资源"><Resources refs={v.resources} /></Fact></dl>
    <section><h2 className="mb-2 font-semibold">动作绑定</h2>{Object.entries(v.actions).map(([name, a]) => <div key={name} className="space-y-2 border-t border-line py-3">
      <h3>{name} → <VersionLink k="executors" v={a.executor} /></h3><dl className="grid gap-2 sm:grid-cols-2"><ExecutionTarget target={a.executor} /><Fact label="固定资源"><Resources refs={a.resources} /></Fact></dl>
    </div>)}</section></>
}
export function History({ k, id }: { k: Collection; id: string }) {
  const result = useResource(async signal => {
    const [{ latest }, versions] = await Promise.all([readVersion(k, id, undefined, signal), history(k, id, signal)])
    return { latest, versions }
  }, null)
  if (!result.data || result.error || result.loading) return <ResourceState loading={result.loading} error={result.error} onRetry={result.reload} />
  const { latest, versions } = result.data
  return <section className="page-stack"><PageHeader title="历史版本" /><p>{id} · 对象{latest.active ? '已启用' : '已停用'}</p>
    <ol className="divide-y divide-line">{versions.slice().reverse().map(v => <li className="py-2" key={v.revision}><VersionLink k={k} v={v} /> {v.revision === latest.revision && '（最新）'}</li>)}</ol>
    <Link className="text-accent-2" to={`/${k}`}>返回{titles[k]}目录</Link></section>
}
export function Detail({ k, id, revision }: { k: Collection; id: string; revision?: string }) {
  const result = useResource(signal => readVersion(k, id, revision, signal), null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function disable() {
    if (busy) return
    setBusy(true); setError('')
    try { await deactivate(k, id); setConfirm(false); result.reload() }
    catch (err) { setError(errorMessage(err)) }
    finally { setBusy(false) }
  }
  if (!result.data || result.error || result.loading) return <ResourceState loading={result.loading} error={result.error} onRetry={result.reload} />
  const { latest, version: v } = result.data
  const path = revisionPath(k, v)
  return <article className="page-stack max-w-5xl"><PageHeader title={`${titles[k]}详情`} /><div>
    <h2 className="break-all text-lg font-semibold">{id} v{v.revision}</h2><p>对象{latest.active ? '已启用' : '已停用'} · 最新 v{latest.revision}</p></div>
    <nav className="flex flex-wrap gap-2" aria-label="定义操作">
      {latest.active && k === 'packages' && <Button asChild variant="primary"><Link to={`/items/new?${new URLSearchParams({ package: id, revision: String(v.revision) })}`}>发起工作</Link></Button>}
      {latest.active && <Button asChild><Link to={`${path}/edit`}>编辑并发布新版</Link></Button>}
      <Button asChild><Link to={`${objectPath(k, id)}/revisions`}>历史版本</Link></Button><Button asChild><Link to={`/${k}`}>返回目录</Link></Button>
      {latest.active && <Button variant="danger" onClick={() => { setError(''); setConfirm(true) }}>停用{titles[k]}</Button>}
    </nav><VersionBody v={v} />
    <Modal open={confirm} title={`停用${titles[k]} ${id}？`} onClose={() => { if (!busy) setConfirm(false) }}>
      <p>停用影响整个 ID，将阻止使用它的新派工、新引用及新版发布。已发布的历史版本仍可查看。</p>
      {error && <p className="text-err" role="alert">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2"><Button disabled={busy} onClick={() => setConfirm(false)}>取消</Button><Button loading={busy} variant="danger" onClick={disable}>确认停用</Button></div>
    </Modal></article>
}
