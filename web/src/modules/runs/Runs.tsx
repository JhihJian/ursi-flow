import { Link } from 'react-router'
import { runtime } from '@/shared/api'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'

export function Runs() {
  const list = useResource(runtime.runs, [])
  return <div className="page-stack"><PageHeader title="运行记录" actions={<Button icon="refresh" onClick={list.reload} disabled={list.loading}>刷新</Button>} />
    <ResourceState {...list} empty={!list.data.length} onRetry={list.reload} title={list.error ? undefined : '暂无运行记录'} />
    {list.data.length > 0 && <ul className="panel divide-y divide-line">{list.data.map(run => <li key={run.id}>
      <Link to={`/runs/${encodeURIComponent(run.id)}`} className="flex items-center justify-between gap-3 p-4 hover:bg-elevated"><span className="min-w-0 break-all"><strong>{run.id}</strong><small className="block text-txt3">Flow：{run.flow}</small></span><span className="text-sm">{run.status}</span></Link>
    </li>)}</ul>}
  </div>
}
