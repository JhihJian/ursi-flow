import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { patchPath } from '@/modules/patches/PatchModel'
import { errorMessage } from '@/shared/api'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Modal } from '@/shared/ui/modal'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Choice } from './Fields'
import { ConfigFields } from './ConfigFields'
import { configDefaults } from './config'
import { deactivate, history, resourceKindNames, list, objectPath, readVersion, revisionPath, routePath, titles, type Collection, type Definition, type Executor, type Latest, type Ref } from './catalog'

function VersionLink({ k, v }: { k: Collection; v: Ref }) {
  return <Link className="break-all font-medium text-accent-2 hover:underline" to={revisionPath(k, v)}>{v.id} v{v.revision}</Link>
}
function ExecutorDirectory({ items }: { items: Latest[] }) {
  return <ul className="divide-y divide-line border-y border-line" aria-label="执行器列表">
    {items.map(v => {
      if ('content' in v) return null
      return <li key={v.id} className="grid gap-2 py-3 md:grid-cols-[minmax(12rem,1.2fr)_minmax(12rem,1fr)_auto] md:items-center">
        <div className="min-w-0"><VersionLink k="executors" v={v} /><p className="mt-1 text-xs text-txt3">workspace + workInstruction → artifactDirectory</p></div>
        <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-sm"><span>{v.resources?.length ?? 0} 个固定资源</span><span className="text-txt3">{v.configSchema?.fields.length ?? 0} 个配置字段</span></div>
        <span className="text-sm text-txt3 md:text-right">v{v.revision} · 对象{v.active ? '已启用' : '已停用'}</span>
      </li>
    })}
  </ul>
}
export function Directory({ k }: { k: Collection }) {
  const name = titles[k]
  const result = useResource(signal => list(k, signal), [])
  const [filter, setFilter] = useState('')
  const items = result.data.filter(v => !filter || ('kind' in v && v.kind === filter))
  const description = k === 'executors' ? '可复用的执行能力。接受 workspace 和 workInstruction，输出 artifactDirectory。' : undefined
  return <section className="page-stack"><PageHeader title={k === 'resources' ? '资源库' : name} description={description} actions={<Button variant="primary" asChild><Link to={`${routePath(k)}/new`}>新建{name}</Link></Button>} />
    {k === 'resources' && <div className="max-w-xs"><Choice label="资源类型筛选" value={filter} change={setFilter} options={[["", "全部"], ["skill", "Skill"], ["prompt", "提示词"], ["mcp", "MCP 引用"]]} /></div>}
    {result.loading || result.error || !items.length ? <ResourceState loading={result.loading} error={result.error} empty title={result.error ? undefined : `暂无${name}`} onRetry={result.reload} /> :
      k === 'executors' ? <ExecutorDirectory items={items} /> : <ul className="divide-y divide-line border-y border-line">{items.map(v => <li key={v.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
        <VersionLink k={k} v={v} />{'kind' in v && <span>{resourceKindNames[v.kind]}</span>}
        <span className="ml-auto text-txt3">对象{v.active ? '已启用' : '已停用'}</span>
      </li>)}</ul>}
  </section>
}
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="field-label">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{children}</dd></div>
}
function Resources({ refs }: { refs?: Ref[] }) {
  return refs?.length ? <ul>{refs.map((v, n) => <li key={n}><VersionLink k="resources" v={v} /></li>)}</ul> : '无'
}
function ConfigSchemaForm({ schema }: { schema?: Executor['configSchema'] }) {
  if (!schema?.fields.length) return null
  return <ConfigFields schema={schema} values={configDefaults(schema)} onValueChange={() => {}} readOnly />
}
function ExecutorContract() {
  return <section className="space-y-3 border-y border-line py-4" aria-labelledby="executor-contract-detail">
    <div><h2 id="executor-contract-detail" className="font-semibold">执行契约</h2>
      <p className="mt-1 text-sm text-txt3">执行器定义只描述可复用的执行能力，不保存某次工作、目录或日志。</p></div>
    <p className="font-mono text-sm">workspace + workInstruction → artifactDirectory</p>
    <dl className="grid gap-3 sm:grid-cols-2"><Fact label="平台记录日志">执行详情中的第一部分，记录平台准备、状态和制品目录生命周期。</Fact>
      <Fact label="执行器记录日志">执行详情中的第二部分，当前显示记录状态，查看器暂未实现。</Fact></dl>
  </section>
}
function VersionBody({ v }: { v: Definition }) {
  if ('content' in v) return <dl className="space-y-4"><Fact label="类型">{resourceKindNames[v.kind]}</Fact>{typeof v.content === 'string'
    ? <><Fact label="资源内容">{v.content}</Fact></>
    : <><Fact label="服务引用">{v.content.serverRef}</Fact><Fact label="凭据引用">{v.content.credentialRef || '无'}</Fact>
      <Fact label="执行边界">只登记服务与凭据的命名引用；连接参数由管理员管理，当前执行后端不支持注入 MCP，所以它不能作为执行依赖。</Fact></>}</dl>
  return <><ExecutorContract /><dl className="space-y-4"><Fact label="资源依赖"><Resources refs={v.resources} /></Fact>
    {v.agent && ('configPackageId' in v.agent
      ? <Fact label="配置包"><Link className="text-accent-2" to={patchPath('config', v.agent.configPackageId)}>{v.agent.configPackageId}</Link></Fact>
      : <><Fact label="固定指令">{v.agent.systemPrompt}</Fact><Fact label="受管模型">{v.agent.modelProfile}</Fact><Fact label="声明的工具">{v.agent.tools.join('、') || '无'}</Fact></>)}
    </dl><ConfigSchemaForm schema={v.configSchema} /></>
}
export function History({ k, id }: { k: Collection; id: string }) {
  const result = useResource(async signal => {
    const [{ latest }, versions] = await Promise.all([readVersion(k, id, undefined, signal), history(k, id, signal)])
    return { latest, versions }
  }, null)
  if (!result.data || result.error || result.loading) return <ResourceState loading={result.loading} error={result.error} onRetry={result.reload} />
  const { latest, versions } = result.data
  return <section className="page-stack"><PageHeader title="历史版本" /><p>{id} · 对象{latest.active ? '已启用' : '已停用'} · 最新 v{latest.revision}</p>
    <ol className="divide-y divide-line">{versions.slice().reverse().map(v => <li className="py-2" key={v.revision}><VersionLink k={k} v={v} /> {v.revision === latest.revision && '（最新）'}</li>)}</ol>
    <Link className="text-accent-2" to={routePath(k)}>返回{titles[k]}目录</Link></section>
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
  const frozen = v.revision !== latest.revision
  return <article className="page-stack max-w-5xl"><PageHeader title={`${titles[k]}详情`} /><div>
    <h2 className="break-all text-lg font-semibold">{id} v{v.revision}</h2>
    <p>正在阅读 v{v.revision} · 最新 v{latest.revision} · 对象{latest.active ? '已启用' : '已停用'}</p>
    {frozen && <p className="text-sm text-txt3">这是冻结的历史版本，只读；发布新版会创建新的修订号。</p>}</div>
    <nav className="flex flex-wrap gap-2" aria-label="定义操作">
      {latest.active && <Button asChild><Link to={`${path}/edit`}>编辑并发布新版</Link></Button>}
      <Button asChild><Link to={`${objectPath(k, id)}/revisions`}>历史版本</Link></Button><Button asChild><Link to={routePath(k)}>返回目录</Link></Button>
      {latest.active && <Button variant="danger" onClick={() => { setError(''); setConfirm(true) }}>停用{titles[k]}</Button>}
    </nav><VersionBody v={v} />
    <Modal open={confirm} title={`停用${titles[k]} ${id}？`} onClose={() => { if (!busy) setConfirm(false) }}>
      <p>停用后不能再引用此 ID 或发布新版。已发布的历史版本仍可查看。</p>
      {error && <p className="text-err" role="alert">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2"><Button disabled={busy} onClick={() => setConfirm(false)}>取消</Button><Button loading={busy} variant="danger" onClick={disable}>确认停用</Button></div>
    </Modal></article>
}
