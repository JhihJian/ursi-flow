import { type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { itemPath, itemStatus, listItems, statusOptions, type ItemStatus, type ItemSummary } from './model'

function sourceLabel(source: { type: string; provider?: string; itemId?: string; action?: string }) {
  if (source.type === 'builtin') return '内置派工'
  return [source.provider, source.itemId, source.action].filter(Boolean).join(' · ') || '外部来源'
}

export function WorkList() {
  const requested = new URLSearchParams(useLocation().search).get('status')
  const status = statusOptions.find(option => option.value === requested)?.value ?? ''
  return <FilteredList key={status} status={status} />
}

function FilteredList({ status }: { status: ItemStatus | '' }) {
  const result = useResource(signal => listItems(status, signal), [])
  const failed = Boolean(result.error)

  return <div className="page-stack break-words">
    <PageHeader title="派工记录" description="按状态查找待办理和待验收的工作项" actions={<>
      <Button icon="refresh" onClick={result.reload} disabled={result.loading}>刷新</Button>
      <Button variant="primary" asChild><Link to="/items/new">发起工作</Link></Button>
    </>} />
    <nav aria-label="状态筛选" className="flex flex-wrap gap-2">
      {statusOptions.map(option => <Link key={option.value} aria-current={option.value === status ? 'page' : undefined}
        to={option.value ? `/items?status=${encodeURIComponent(option.value)}` : '/items'}
        className={cn('rounded-full border px-3 py-1 text-sm', option.value === status
          ? 'border-accent bg-accent/10 font-medium text-txt'
          : 'border-line text-txt2 hover:border-line-strong hover:text-txt')}>
        {option.label}
      </Link>)}
    </nav>
    <ResourceState loading={result.loading && result.data.length === 0} error={result.error}
      empty={!result.loading && !result.error && result.data.length === 0}
      title={result.error ? undefined : status ? `暂无${itemStatus[status]}工作项` : '暂无工作项'}
      description={result.error ? undefined : status ? '切换筛选，或发起一张新的工作项。' : '发起一张工作项后，它会出现在这里。'}
      onRetry={result.reload}>
      <Button variant="primary" asChild><Link to="/items/new">发起工作</Link></Button>
    </ResourceState>
    {!failed && result.data.length > 0 && <ItemsTable items={result.data} status={status} />}
  </div>
}

function ItemsTable({ items, status }: { items: ItemSummary[]; status: ItemStatus | '' }) {
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  return <div className="border-y border-line">
    <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto] gap-4 border-b border-line px-4 py-2 text-xs text-txt3 sm:grid">
      <span>派工模板</span><span>单号</span><span>来源</span><span>经办人</span><span>状态</span>
    </div>
    <ul className="divide-y divide-line">
      {items.map(item => <li key={item.id}>
        <Link to={`${itemPath(item.id)}${query}`}
          className="grid gap-2 px-4 py-3 hover:bg-elevated sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto] sm:items-center sm:gap-4">
          <Cell label="派工模板"><strong className="break-all font-medium">{item.package}</strong> <span className="text-txt3">v{item.revision}</span></Cell>
          <Cell label="单号"><span className="break-all font-mono text-xs text-txt2">{item.id}</span></Cell>
          <Cell label="来源"><span className="break-words text-sm text-txt2">{sourceLabel(item.source)}</span></Cell>
          <Cell label="经办人"><span className="text-sm text-txt2">{item.assignee || '未指定'}</span></Cell>
          <Cell label="状态"><span className="text-sm font-medium sm:justify-self-end">{itemStatus[item.status]}</span></Cell>
        </Link>
      </li>)}
    </ul>
  </div>
}

/** 移动端逐项列出，标签只在窄屏出现；宽屏由表头承担同样的说明。 */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return <span className="min-w-0">
    <span className="mr-1 text-xs text-txt3 sm:hidden">{label}</span>{' '}
    {children}
  </span>
}
