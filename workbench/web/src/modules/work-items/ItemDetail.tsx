import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { listPatches } from '@/modules/patches/api'
import { patchPath } from '@/modules/patches/PatchModel'
import { generationHistoryPath } from '@/shared/api/work-patch-generators'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Modal } from '@/shared/ui/modal'
import { ResourceState } from '@/shared/ui/resource-state'
import { categories, deleteWorkItem, getWorkItem, statuses, workItemPath, type WorkItem } from '@/shared/api/work-items'
import { canvasPath, getPlacement, projectsPath, type Placement } from '@/shared/api/work-projects'
import { useProjectNavigation } from './projects/project-navigation'

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
  const { refreshWorkspaces } = useProjectNavigation()
  const patches = useResource(signal => listPatches('work', signal), [])
  const related = patches.data.filter(p => p.workItemId === item.id)
  const [deleting, setDeleting] = useState(false)
  const deletion = useMutation()
  return <div className="page-stack break-words">
    <header className="space-y-2"><Link className="text-sm text-accent-2" to="/work-items">返回工作清单</Link>
      <h1 className="break-all text-xl font-semibold">{item.title}</h1>
      <div className="flex flex-wrap items-center gap-3"><span>{categories[item.category]}</span><span>{statuses[item.status]}</span>
        <Button asChild><Link to={`${workItemPath(item.id)}/edit`}>编辑工作项</Link></Button>
        <Button variant="danger" disabled={patches.loading || !!patches.error} onClick={() => setDeleting(true)}>删除工作项</Button></div>
    </header>
    <section className="space-y-2 border-t border-line pt-4"><h2 className="font-semibold">工作说明</h2><p className="whitespace-pre-wrap text-sm">{item.description || '暂无说明'}</p></section>
    <ItemPlacement itemId={item.id} />
    <section className="space-y-2 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-3"><h2 className="font-semibold">生成记录</h2>
        <Button asChild size="sm"><Link to={generationHistoryPath({ workItemId: item.id })}>查看本项的生成记录</Link></Button>
      </div>
      <p className="text-sm text-txt3">生成工作包请从工作包生成器发起；这里的记录按本项筛选。</p>
    </section>
    <section className="space-y-2 border-t border-line pt-4"><h2 className="font-semibold">关联工作包</h2>
      <ResourceState loading={patches.loading} error={patches.error} onRetry={patches.reload} empty={!related.length} title={patches.error ? undefined : '暂无关联工作包'} />
      <ul>{related.map(p => <li key={p.id}><Link className="text-accent-2 hover:underline" to={patchPath('work', p.id)}>{p.name}</Link></li>)}</ul>
    </section>
    <Modal open={deleting} title="删除工作项" onClose={() => { if (!deletion.busy) setDeleting(false) }} footer={<>
      <Button disabled={deletion.busy} onClick={() => setDeleting(false)}>取消</Button>
      <Button variant="danger" loading={deletion.busy} onClick={() => void deletion.run(signal => deleteWorkItem(item.id, signal), () => {
        refreshWorkspaces()
        navigate('/work-items', { replace: true })
      })}>确认删除</Button></>}>
      <p>删除「{item.title}」将解除 {related.length} 个工作包的关联。包、文件和生成记录会保留。</p>
      {deletion.error && <p role="alert" className="text-err">{deletion.error}</p>}
    </Modal>
  </div>
}

function ItemPlacement({ itemId }: { itemId: string }) {
  const placement = useResource<Placement | null>(signal => getPlacement(itemId, signal), null, itemId)
  const location = placement.data
  return <section className="space-y-2 border-t border-line pt-4">
    <h2 className="font-semibold">项目归属</h2>
    {placement.loading || placement.error ? <ResourceState loading={placement.loading} error={placement.error} onRetry={placement.reload} /> :
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <p className="text-txt3">{location ? '已归属项目任务卡' : '尚未归属项目'}</p>
        {location ? <Button asChild size="sm"><Link to={{
          pathname: canvasPath(location.projectId, location.canvasId),
          search: `?${new URLSearchParams({ focusItemId: itemId })}`,
        }}>在画布中定位</Link></Button> : <Button asChild size="sm"><Link to={projectsPath}>打开工作项目</Link></Button>}
      </div>}
  </section>
}
