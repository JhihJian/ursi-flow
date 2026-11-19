import { Link, useParams } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { sourceItemPath, listSourceItems, sourcePath } from './model'

export function SourceItems() {
  const { provider } = useParams()
  const result = useResource(signal => listSourceItems(provider!, signal), [])
  return <div className="page-stack break-words">
    <PageHeader title="来源条目" description={provider} actions={<><Button asChild><Link to="/sources">返回来源</Link></Button><Button icon="refresh" onClick={result.reload} disabled={result.loading}>刷新</Button></>} />
    <ResourceState loading={result.loading && result.data.length === 0} error={result.error} empty={!result.loading && !result.error && result.data.length === 0} title={result.error ? undefined : '暂无来源条目'} description="当前导出中没有可派工的资源。" onRetry={result.reload} />
    {result.data.length > 0 && <ul className="divide-y divide-line border-y border-line">{result.data.map(item => <li key={item.id}><Link className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-4 hover:bg-elevated" to={sourceItemPath(provider!, item.id)}><span className="min-w-0 flex-1"><strong className="block break-all">{item.title}</strong><small className="mt-1 block break-all text-txt3">{item.id}</small></span><span className="text-accent-2">查看详情</span></Link></li>)}</ul>}
    <Link className="text-sm text-accent-2 hover:underline" to={sourcePath(provider!)}>返回来源信息</Link>
  </div>
}
