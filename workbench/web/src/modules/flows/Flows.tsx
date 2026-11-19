import { Link } from 'react-router'
import { runtime } from '@/shared/api'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Icon } from '@/shared/ui/icon'

export function Flows() {
  const list = useResource(runtime.flows, [])
  return <div className="page-stack">
    <PageHeader title="Flow 包" description="运行工作区的流程目录" actions={<>
      <Button icon="refresh" onClick={list.reload} disabled={list.loading}>刷新</Button>
      <Button variant="primary" asChild><Link to="/flows/new">创建 Flow</Link></Button>
    </>} />
    <ResourceState {...list} empty={!list.data.length} title={list.error ? undefined : '暂无 Flow 包'} onRetry={list.reload} />
    {list.data.length > 0 && <ul className="panel divide-y divide-line">{list.data.map(id => <li key={id}>
      <Link className="flex items-center gap-3 p-4 hover:bg-elevated" to={`/flows/${encodeURIComponent(id)}/edit`}><Icon name="workflow" /><span className="min-w-0 flex-1 break-all font-mono">{id}</span><Icon name="chevron-right" /></Link>
    </li>)}</ul>}
  </div>
}
