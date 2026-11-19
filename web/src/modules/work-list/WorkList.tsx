import { Link, useLocation, useNavigate } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { Icon } from '@/shared/ui/icon'
import { itemPath, itemStatus, listItems, statusOptions, type ItemStatus } from './model'

function sourceLabel(source: { type: string; provider?: string; itemId?: string; action?: string }) {
  if (source.type === 'builtin') return '内置派工'
  return [source.provider, source.itemId, source.action].filter(Boolean).join(' · ') || '外部来源'
}

export function WorkList() {
  const location = useLocation()
  const requested = new URLSearchParams(location.search).get('status')
  const status = statusOptions.find(option => option.value === requested)?.value ?? ''
  return <FilteredList key={status} status={status} />
}

function FilteredList({ status }: { status: ItemStatus | '' }) {
  const navigate = useNavigate()
  const result = useResource(signal => listItems(status, signal), [])

  return <div className="page-stack break-words">
    <PageHeader title="工作清单" description="按状态查找待办理和待验收的工作项" actions={<>
      <Button icon="refresh" onClick={result.reload} disabled={result.loading}>刷新</Button>
      <Button variant="primary" asChild><Link to="/items/new">发起工作</Link></Button>
    </>} />
    <div className="flex flex-wrap items-end gap-3">
      <label className="field w-full max-w-xs"><span className="field-label">状态筛选</span><Select aria-label="状态筛选" value={status} onChange={event => {
        const next = event.target.value
        navigate(next ? `/items?status=${encodeURIComponent(next)}` : '/items')
      }}>{statusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></label>
    </div>
    <ResourceState loading={result.loading && result.data.length === 0} error={result.error} empty={!result.loading && !result.error && result.data.length === 0}
      title={result.error ? undefined : status ? `暂无${itemStatus[status]}工作项` : '暂无工作项'} description={result.error ? undefined : status ? '切换筛选或发起一张新的工作项。' : '发起一张工作项后，它会出现在这里。'} onRetry={result.reload}>
      <Button variant="primary" asChild><Link to="/items/new">发起工作</Link></Button>
    </ResourceState>
    {!result.error && result.data.length > 0 && <div className="overflow-hidden border-y border-line">
      <div className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-4 border-b border-line px-4 py-2 text-xs text-txt3 sm:grid">
        <span>工作项</span><span>来源</span><span>经办人</span><span>状态</span>
      </div>
      <ul className="divide-y divide-line">{result.data.map(item => <li key={item.id}>
        <Link to={`${itemPath(item.id)}${status ? `?status=${encodeURIComponent(status)}` : ''}`} className="grid gap-2 px-4 py-3 hover:bg-elevated sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-4">
          <span className="min-w-0"><strong className="block break-all font-medium">{item.package} v{item.revision}</strong><small className="mt-1 block break-all text-xs text-txt3">{item.id}</small></span>
          <span className="min-w-0 break-words text-sm text-txt2">{sourceLabel(item.source)}</span>
          <span className="text-sm text-txt2">{item.assignee || '未指定'}</span>
          <span className="flex items-center gap-1.5 text-sm font-medium sm:justify-self-end"><Icon name="status" size={14} />{itemStatus[item.status]}</span>
        </Link>
      </li>)}</ul>
    </div>}
  </div>
}
