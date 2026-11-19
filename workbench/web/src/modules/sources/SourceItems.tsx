import { Link, useParams } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { listSourceItems, sourceFault, sourceItemPath, sourcePath } from './model'

export function SourceItems() {
  const { provider = '' } = useParams()
  return <SourceItemsList key={provider} provider={provider} />
}

function SourceItemsList({ provider }: { provider: string }) {
  const result = useResource(signal => listSourceItems(provider, signal), [])
  const fault = result.error ? sourceFault(result.error) : null
  const firstLoad = result.loading && result.data.length === 0
  return <div className="page-stack break-words">
    <PageHeader title="来源条目" description={provider} actions={<>
      <Button asChild><Link to="/sources">返回来源</Link></Button>
      <Button icon="refresh" onClick={result.reload} disabled={result.loading}>刷新</Button>
    </>} />
    {!firstLoad && fault === 'unconfigured'
      ? <section className="panel space-y-3 p-6" role="status">
        <h2 className="font-semibold">来源未配置</h2>
        <p className="text-sm text-txt2">服务端没有这个来源，或来源已从配置中移除。已派出的单据仍可在工作清单查看。</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button icon="refresh" onClick={result.reload}>重新检查</Button>
          <Link className="text-accent-2 hover:underline" to="/sources">返回来源列表</Link>
        </div>
      </section>
      : <ResourceState
        loading={firstLoad}
        error={fault ? '来源导出暂时不可用。' : ''}
        title={fault ? '暂时无法读取来源条目' : '当前导出没有条目'}
        description={fault ? '服务端无法读取该来源的导出文件，或网络中断。请稍后重试。' : '管理员导出条目后，它们会显示在这里。'}
        empty={!result.loading && !fault && result.data.length === 0}
        onRetry={result.reload}
      />}
    {!fault && result.data.length > 0 && <ul className="divide-y divide-line border-y border-line">{result.data.map(item => <li key={item.id}>
      <Link className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-4 hover:bg-elevated" to={sourceItemPath(provider, item.id)}>
        <span className="min-w-0 flex-1"><strong className="block break-all">{item.title}</strong><small className="mt-1 block break-all text-txt3">{item.id}</small></span>
        <span className="text-accent-2">查看详情</span>
      </Link>
    </li>)}</ul>}
    <Link className="text-sm text-accent-2 hover:underline" to={sourcePath(provider)}>返回来源信息</Link>
  </div>
}
