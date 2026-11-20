import { Link, useSearchParams } from 'react-router'
import { listPatches } from '@/modules/patches/api'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { categories, listWorkItems, workItemPath } from '@/shared/api/work-items'

export function WorkItems() {
  const items = useResource(listWorkItems, [])
  const patches = useResource(signal => listPatches('work', signal), [])
  const [params, setParams] = useSearchParams()
  const category = params.get('category') || ''
  const visible = items.data.filter(item => !category || item.category === category)
  const counts = new Map<string, number>()
  for (const { workItemId } of patches.data) if (workItemId) counts.set(workItemId, (counts.get(workItemId) ?? 0) + 1)
  return <div className="page-stack">
    <PageHeader title="工作清单" actions={<Button variant="primary" asChild><Link to="/work-items/new">新建工作项</Link></Button>} />
    <label className="flex items-center gap-2 text-sm">类别筛选<Select className="w-auto" value={category}
      onChange={e => setParams(e.target.value ? { category: e.target.value } : {})}>
      <option value="">全部类别</option>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </Select></label>
    <ResourceState loading={items.loading} error={items.error} onRetry={items.reload} empty={!visible.length} title={items.error ? undefined : '暂无工作项'} />
    <ResourceState error={patches.error} title="关联工作包数读取失败" onRetry={patches.reload} />
    {!items.loading && !items.error && <ul className="divide-y divide-line">
      {visible.map(item => <li className="flex flex-wrap items-center gap-3 border-b border-line py-3 text-sm" key={item.id}>
        <Link className="min-w-0 flex-auto break-all font-medium text-accent-2 hover:underline" to={workItemPath(item.id)}>{item.title}</Link>
        <span>{categories[item.category]}</span><span className="text-txt3">关联工作包：{patches.error || patches.loading ? '待获取' : counts.get(item.id) ?? 0}</span>
      </li>)}
    </ul>}
  </div>
}
