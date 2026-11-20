import { Link } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { listSources, sourceFault, sourcePath } from './model'

export function Sources() {
  const result = useResource(listSources, [])
  const fault = result.error ? sourceFault(result.error) : null
  const firstLoad = result.loading && result.data.length === 0
  return <div className="page-stack break-words">
    <PageHeader title="外部来源" description="从管理员配置的来源条目选择固定动作派工" actions={<Button icon="refresh" onClick={result.reload} disabled={result.loading}>刷新</Button>} />
    {!firstLoad && fault === 'unconfigured'
      ? <section className="panel space-y-3 p-6" role="status">
        <h2 className="font-semibold">外部来源未启用</h2>
        <p className="text-sm text-txt2">当前服务没有配置来源目录，工作清单仍可独立使用。</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button icon="refresh" onClick={result.reload}>重新检查</Button>
          <Link className="text-accent-2 hover:underline" to="/work-items">返回工作清单</Link>
        </div>
      </section>
      : <ResourceState
        loading={firstLoad}
        error={fault ? '来源目录暂时不可用。' : ''}
        title={fault ? '暂时无法读取来源目录' : '暂无外部来源'}
        description={fault ? '服务端当前无法提供来源目录或网络中断，工作清单仍可独立使用。请稍后重试。' : '管理员配置来源后，来源条目会显示在这里。'}
        empty={!result.loading && !fault && result.data.length === 0}
        retryLabel="重新检查"
        onRetry={result.reload}
      />}
    {!fault && result.data.length > 0 && <ul className="divide-y divide-line border-y border-line">{result.data.map(source => <li key={source.id}>
      <Link to={`${sourcePath(source.id)}/items`} className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-4 hover:bg-elevated">
        <span className="min-w-0 flex-1"><strong className="block break-all">{source.id}</strong><small className="mt-1 block text-txt3">{source.kind} · {source.actions.join('、')}</small></span>
        <span className="text-sm text-accent-2">查看条目</span>
      </Link>
    </li>)}</ul>}
  </div>
}
