import { Link } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { listSources, sourcePath } from './model'

export function Sources() {
  const result = useResource(listSources, [])
  const unavailable = result.error.includes('HTTP 404')
  return <div className="page-stack break-words">
    <PageHeader title="外部来源" description="从管理员配置的来源条目选择固定动作" actions={<Button icon="refresh" onClick={result.reload} disabled={result.loading}>刷新</Button>} />
    {unavailable ? <section className="panel space-y-3 p-6"><h2 className="font-semibold">外部来源未启用</h2><p className="text-sm text-txt2">当前服务没有挂载来源目录，工作清单仍可独立使用。</p><Link className="text-accent-2 hover:underline" to="/items">返回工作清单</Link></section> : <ResourceState loading={result.loading && result.data.length === 0} error={result.error} empty={!result.loading && !result.error && result.data.length === 0} title={result.error ? undefined : '暂无外部来源'} description="管理员配置来源后，资源条目会显示在这里。" onRetry={result.reload} />}
    {!unavailable && result.data.length > 0 && <ul className="divide-y divide-line border-y border-line">{result.data.map(source => <li key={source.id}><Link to={`${sourcePath(source.id)}/items`} className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-4 hover:bg-elevated"><span className="min-w-0 flex-1"><strong className="block break-all">{source.id}</strong><small className="mt-1 block text-txt3">{source.kind} · {source.actions.join('、')}</small></span><span className="text-sm text-accent-2">查看条目</span></Link></li>)}</ul>}
  </div>
}
