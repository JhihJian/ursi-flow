import { useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { listPatches } from '@/modules/patches/api'
import { patchPath } from '@/modules/patches/PatchModel'
import { useStartGeneration } from '@/modules/work-patch-generators/use-start-generation'
import { generationHistoryPath, generatorRevisionPath } from '@/shared/api/work-patch-generators'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Modal } from '@/shared/ui/modal'
import { ResourceState } from '@/shared/ui/resource-state'
import { categories, deleteWorkItem, generatePatch, getWorkItem, statuses, workItemPath, type WorkItem } from '@/shared/api/work-items'

export function ItemDetail() {
  const { id = '' } = useParams()
  return <LoadItem key={id} id={id} />
}
function LoadItem({ id }: { id: string }) {
  const item = useResource(signal => getWorkItem(id, signal), null)
  return item.data ? <Detail item={item.data} /> : <ResourceState loading={item.loading} error={item.error} onRetry={item.reload} />
}
function Detail({ item }: { item: WorkItem }) {
  const navigate = useNavigate()
  const patches = useResource(signal => listPatches('work', signal), [])
  const related = patches.data.filter(p => p.workItemId === item.id)
  const [deleting, setDeleting] = useState(false)
  const deletion = useMutation()
  const generation = useMutation()
  const generatorRun = useStartGeneration()
  const requestId = useRef('')
  function generate() {
    // 响应丢失后仍用同一标识；成功后再生成是另一次主动操作。
    requestId.current ||= Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
    void generation.run(signal => generatePatch(item.id, requestId.current, signal), patch => {
      requestId.current = ''
      navigate(patchPath('work', patch.id))
    })
  }
  return <div className="page-stack break-words">
    <header className="space-y-2"><Link className="text-sm text-accent-2" to="/work-items">返回工作清单</Link>
      <h1 className="break-all text-xl font-semibold">{item.title}</h1>
      <div className="flex flex-wrap items-center gap-3"><span>{categories[item.category]}</span><span>{statuses[item.status]}</span>
        <Button asChild><Link to={`${workItemPath(item.id)}/edit`}>编辑工作项</Link></Button>
        <Button variant="danger" disabled={patches.loading || !!patches.error || generation.busy || generatorRun.busy} onClick={() => setDeleting(true)}>删除工作项</Button></div>
    </header>
    <section className="space-y-2 border-t border-line pt-4"><h2 className="font-semibold">工作说明</h2><p className="whitespace-pre-wrap text-sm">{item.description || '暂无说明'}</p></section>
    <section className="space-y-2 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-3"><h2 className="font-semibold">工作包来源</h2>
        <Button asChild size="sm"><Link to={generationHistoryPath({ workItemId: item.id })}>生成记录</Link></Button>
      </div>
      {item.generator ? <>
        <p className="text-sm">生成器：<Link className="break-all text-accent-2 underline" to={generatorRevisionPath(item.generator)}>
          {item.generator.id} · 第 {item.generator.revision} 版</Link></p>
        <ol className="list-inside list-decimal break-all text-sm">{item.generator.resources.map(ref => <li key={ref.alias}><strong>{ref.alias}</strong> · {ref.serverId} · {ref.uri}</li>)}</ol>
        <Button variant="primary" loading={generatorRun.busy} onClick={() => generatorRun.start({ workItemId: item.id })}>
          {generatorRun.error ? '重试生成工作包' : '生成工作包'}
        </Button>
        {generatorRun.error && <p role="alert" className="text-err">{generatorRun.error}</p>}
      </> : item.recipe ? <><ol className="list-inside list-decimal break-all text-sm">{item.recipe.resources.map(ref => <li key={ref.alias}><strong>{ref.alias}</strong> · {ref.serverId} · {ref.uri}</li>)}</ol>
        <details><summary>Python 脚本</summary><pre className="overflow-auto bg-base p-3 text-sm">{item.recipe.script}</pre></details>
        <Button variant="primary" loading={generation.busy} onClick={generate}>{generation.error ? '重试生成工作包' : '生成工作包'}</Button>
        {generation.error && <p role="alert" className="text-err">{generation.error}</p>}
      </> : <p className="text-sm text-txt3">未配置工作包来源</p>}
    </section>
    <section className="space-y-2 border-t border-line pt-4"><h2 className="font-semibold">关联工作包</h2>
      <ResourceState loading={patches.loading} error={patches.error} onRetry={patches.reload} empty={!related.length} title={patches.error ? undefined : '暂无关联工作包'} />
      <ul>{related.map(p => <li key={p.id}><Link className="text-accent-2 hover:underline" to={patchPath('work', p.id)}>{p.name}</Link></li>)}</ul>
    </section>
    <Modal open={deleting} title="删除工作项" onClose={() => { if (!deletion.busy) setDeleting(false) }} footer={<>
      <Button disabled={deletion.busy} onClick={() => setDeleting(false)}>取消</Button>
      <Button variant="danger" loading={deletion.busy} onClick={() => void deletion.run(signal => deleteWorkItem(item.id, signal), () => navigate('/work-items', { replace: true }))}>确认删除</Button></>}>
      <p>删除「{item.title}」将解除 {related.length} 个工作包的关联。包、文件和生成记录会保留。</p>
      {deletion.error && <p role="alert" className="text-err">{deletion.error}</p>}
    </Modal>
  </div>
}
