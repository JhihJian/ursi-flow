import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { api } from '@/shared/api'
import type { Artifact, Run } from '@/shared/api/types'
import { useResource } from '@/shared/hooks/use-resource'
import { cn } from '@/shared/lib/utils'
import { notify } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { MarkdownContent } from '@/shared/ui/markdown-content'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { TabBar } from '@/shared/ui/tabs'

const TABS = [
  { id: 'preview', label: '内容预览' },
  { id: 'source', label: '源文件' },
]

function formatSize(size: number): string {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

/** 产物目录：搜索、运行与轮次筛选、内容预览、源文件与 Blob 下载。 */
export default function ArtifactsView() {
  const [searchParams, setSearchParams] = useSearchParams()
  // 运行与轮次筛选以地址栏为唯一来源，外部导航与前进后退都能回到同一视图。
  const runFilter = searchParams.get('runId') ?? ''
  const attemptFilter = searchParams.get('attempt') ?? ''

  const { data, loading, error, reload } = useResource<Artifact[]>(
    (signal) => api.get<Artifact[]>('/artifacts', signal),
    [],
  )
  const runs = useResource<Run[]>((signal) => api.get<Run[]>('/runs', signal), [])

  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState(searchParams.get('id') ?? '')
  const [tab, setTab] = useState('preview')

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return data.filter((item) => (
      (!runFilter || item.runId === runFilter)
      && (!attemptFilter || String(item.attempt) === attemptFilter)
      && `${item.name} ${item.path}`.toLowerCase().includes(keyword)
    ))
  }, [attemptFilter, data, runFilter, search])

  const selected = useMemo(
    () => filtered.find((item) => item.id === selection) ?? filtered[0],
    [filtered, selection],
  )

  const attempts = useMemo(() => {
    const scoped = data.filter((item) => !runFilter || item.runId === runFilter)
    return [...new Set(scoped.map((item) => item.attempt))].sort((a, b) => b - a)
  }, [data, runFilter])

  function changeRunFilter(next: string) {
    // 切换运行时清空轮次筛选，只保留运行查询参数。
    setSearchParams(next ? { runId: next } : {}, { replace: true })
  }

  function changeAttemptFilter(next: string) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next) params.set('attempt', next)
      else params.delete('attempt')
      return params
    }, { replace: true })
  }

  const nameOfRun = (id: string) => runs.data.find((run) => run.id === id)?.name ?? id

  function download() {
    if (!selected) return
    const url = URL.createObjectURL(new Blob([selected.content], { type: selected.contentType }))
    const link = document.createElement('a')
    link.href = url
    link.download = selected.name
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
    notify('产物已开始下载')
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="产物管理"
        description="把每一次执行的结果，沉淀为可追溯的交付物。"
        icon="artifact"
        actions={<Button icon="refresh" loading={loading} onClick={() => { reload() }}>刷新</Button>}
      />
      <div className="toolbar">
        <label className="search-input">
          <Icon name="search" size={16} />
          <input
            type="search"
            aria-label="搜索产物"
            placeholder="搜索文件名称或路径…"
            value={search}
            onChange={(event) => { setSearch(event.target.value) }}
          />
        </label>
        <div className="flex max-w-full flex-wrap gap-2">
          <Select
            className="!w-auto max-w-[240px]"
            aria-label="按运行筛选"
            value={runFilter}
            onChange={(event) => { changeRunFilter(event.target.value) }}
          >
            <option value="">全部运行</option>
            {runs.data.map((run) => <option key={run.id} value={run.id}>{run.name}</option>)}
          </Select>
          <Select
            className="!w-auto"
            aria-label="执行轮次"
            value={attemptFilter}
            onChange={(event) => { changeAttemptFilter(event.target.value) }}
          >
            <option value="">全部轮次</option>
            {attempts.map((attempt) => (
              <option key={attempt} value={String(attempt)}>第 {attempt} 次执行</option>
            ))}
          </Select>
        </div>
      </div>
      <ResourceState
        loading={loading}
        error={error}
        empty={!filtered.length}
        title={error ? undefined : '没有找到产物'}
        description={error ? undefined : '调整筛选条件，或完成一次流程运行来生成交付物。'}
        onRetry={() => { reload() }}
      />
      {!loading && !error && selected ? (
        <div className="panel grid grid-cols-1 overflow-hidden lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="max-h-[260px] overflow-auto border-b border-line bg-base/50 pb-3 lg:max-h-[740px] lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between px-5 py-4 text-xs text-txt3">
              <span>交付文件</span>
              <span>{filtered.length} 个文件</span>
            </div>
            {filtered.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn(
                  'mx-2 my-0.5 flex w-[calc(100%-16px)] items-center gap-3 rounded-lg p-3 text-left transition-colors',
                  selected.id === item.id ? 'bg-accent-dim' : 'hover:bg-elevated',
                )}
                aria-pressed={selected.id === item.id}
                onClick={() => { setSelection(item.id) }}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-accent-2">
                  <Icon name="doc" size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-txt">{item.name}</span>
                  <span className="mt-1 block truncate text-xs text-txt3">
                    第 {item.attempt} 次执行 · {formatSize(item.size)}
                  </span>
                </span>
              </button>
            ))}
          </aside>
          <section className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <h2 className="truncate font-semibold">{selected.name}</h2>
                <p className="mt-1 break-all text-xs text-txt3">{selected.path}</p>
              </div>
              <Button icon="download" onClick={download}>下载文件</Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-elevated/30 px-5 py-3 text-xs text-txt3">
              <Link to={`/runs/${selected.runId}`} className="text-accent-2 hover:underline">
                {nameOfRun(selected.runId)}
              </Link>
              <span>节点 {selected.nodeId}</span>
              <span>第 {selected.attempt} 次执行</span>
              <time>{formatTime(selected.createdAt)}</time>
            </div>
            <div className="px-5 pt-2">
              <TabBar tabs={TABS} value={tab} onValueChange={setTab} />
            </div>
            <div className="min-h-[380px] px-6 py-7 sm:px-9">
              {tab === 'preview' && selected.contentType === 'text/markdown' ? (
                <MarkdownContent content={selected.content} />
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-7 text-txt2">{selected.content}</pre>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
