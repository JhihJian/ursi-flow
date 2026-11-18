import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { api } from '@/shared/api'
import type { Run, RunStatus } from '@/shared/api/types'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { StatusPill } from '@/shared/ui/status-pill'
import { formatTime, statusLabels } from './runState'

const statuses = Object.entries(statusLabels) as [RunStatus, string][]

/** 运行目录：搜索与状态、工作流筛选，筛选初值取自地址查询。 */
export default function RunsView() {
  const [searchParams] = useSearchParams()
  const { data, loading, error, reload } = useResource<Run[]>((signal) => api.get<Run[]>('/runs', signal), [])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<RunStatus | ''>(() => {
    const value = searchParams.get('status')
    return value && value in statusLabels ? value as RunStatus : ''
  })
  const [workflowId, setWorkflowId] = useState(() => searchParams.get('workflowId') ?? '')

  const workflows = useMemo(() => [...new Map(data.map((run) => [run.workflowId, run.workflowName])).entries()], [data])
  const keyword = search.trim().toLowerCase()
  const visible = data
    .filter((run) => (!status || run.status === status) && (!workflowId || run.workflowId === workflowId))
    .filter((run) => `${run.name} ${run.workflowName} ${run.id}`.toLowerCase().includes(keyword))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const filtered = Boolean(search || status || workflowId)

  function clearFilters() {
    setSearch('')
    setStatus('')
    setWorkflowId('')
  }

  return (
    <div className="page-stack page-stack-fill">
      <PageHeader
        title="运行记录"
        description="追踪任务进度，处理人工审批，回看执行过程与交付物。"
        actions={(
          <>
            <Button variant="outline" icon="refresh" loading={loading} onClick={reload}>刷新</Button>
            <Link to="/workflows" className="text-sm font-medium text-accent-2">前往工作流</Link>
          </>
        )}
      />

      <div className="toolbar">
        <div className="flex w-full flex-wrap gap-3 sm:w-auto">
          <input
            className="search-input"
            type="search"
            aria-label="搜索运行"
            placeholder="搜索运行名称、工作流或标识…"
            value={search}
            onChange={(event) => { setSearch(event.target.value) }}
          />
          <Select aria-label="按状态筛选" className="!w-auto" value={status} onChange={(event) => { setStatus(event.target.value as RunStatus | '') }}>
            <option value="">全部状态</option>
            {statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
          <Select aria-label="按工作流筛选" className="!w-auto max-w-[220px]" value={workflowId} onChange={(event) => { setWorkflowId(event.target.value) }}>
            <option value="">全部工作流</option>
            {workflows.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
        </div>
        <span className="text-xs text-txt3">{visible.length} 条运行记录</span>
      </div>

      <ResourceState
        loading={loading}
        error={error}
        empty={!visible.length}
        title={error ? undefined : filtered ? '没有匹配的运行' : '暂无运行记录'}
        description={error ? undefined : filtered ? '调整筛选条件，查看其他运行。' : '从工作流发起任务后，可以在这里追踪进度。'}
        onRetry={reload}
      >
        {filtered
          ? <Button variant="outline" onClick={clearFilters}>清除筛选</Button>
          : <Link to="/workflows" className="text-accent-2">选择工作流</Link>}
      </ResourceState>

      {!loading && !error && visible.length ? (
        <div className="table-wrap table-fill">
          <table className="data-table min-w-[680px]">
            <thead>
              <tr>
                <th scope="col">运行</th>
                <th scope="col">状态</th>
                <th scope="col">进度</th>
                <th scope="col">轮次</th>
                <th scope="col">更新时间</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((run) => {
                const done = run.nodes.filter((node) => node.status === 'succeeded').length
                const percent = run.nodes.length ? (done / run.nodes.length) * 100 : 0
                return (
                  <tr key={run.id}>
                    <td className="w-[44%] max-w-[420px]">
                      <Link to={`/runs/${encodeURIComponent(run.id)}`} className="block truncate">{run.name}</Link>
                      <p className="mt-1 truncate text-xs text-txt3">{run.workflowName}</p>
                    </td>
                    <td><StatusPill status={run.status} /></td>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="block h-1 w-16 overflow-hidden rounded bg-elevated">
                          <span className="block h-full rounded bg-accent" style={{ width: `${percent}%` }} />
                        </span>
                        <span className="whitespace-nowrap text-xs text-txt3">{done}/{run.nodes.length}</span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-xs">第 {run.attempt} 次</td>
                    <td className="whitespace-nowrap text-xs"><time dateTime={run.updatedAt}>{formatTime(run.updatedAt)}</time></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
