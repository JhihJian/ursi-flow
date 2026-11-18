import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { api, errorMessage } from '@/shared/api'
import type { Sandbox } from '@/shared/api/types'
import { useResource } from '@/shared/hooks/use-resource'
import { confirmAction, notify } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { Modal } from '@/shared/ui/modal'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { StatusPill } from '@/shared/ui/status-pill'

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

/** 沙箱目录：资源统计、搜索与状态筛选、生命周期详情与确认释放。 */
export default function SandboxesView() {
  const [searchParams, setSearchParams] = useSearchParams()
  // 选中的资源与 ?id= 一一对应，关联运行携带参数进入时直接打开详情。
  const selectedId = searchParams.get('id') ?? ''

  const { data, loading, error, reload } = useResource<Sandbox[]>(
    (signal) => api.get<Sandbox[]>('/sandboxes', signal),
    [],
  )

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [releasing, setReleasing] = useState('')
  const [releaseError, setReleaseError] = useState('')

  function select(id: string) {
    setSearchParams(id ? { id } : {}, { replace: true })
  }

  const selected = useMemo(() => data.find((item) => item.id === selectedId), [data, selectedId])
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return data.filter((item) => (
      (!statusFilter || item.status === statusFilter)
      && `${item.name} ${item.id}`.toLowerCase().includes(keyword)
    ))
  }, [data, search, statusFilter])

  const metrics = [
    { label: '全部环境', value: data.length, icon: 'server' },
    { label: '使用中', value: data.filter((item) => item.status === 'running').length, icon: 'play' },
    { label: '已释放', value: data.filter((item) => item.status === 'released').length, icon: 'check' },
  ]

  async function release(item: Sandbox) {
    const accepted = await confirmAction({
      title: '释放沙箱？',
      description: `将释放「${item.name}」的演示资源。已回收的产物仍可查询，正在执行任务的沙箱会拒绝释放。`,
      confirmLabel: '释放沙箱',
      danger: true,
    })
    if (!accepted) return
    setReleasing(item.id)
    setReleaseError('')
    try {
      await api.post(`/sandboxes/${item.id}/release`)
      await reload()
      notify('沙箱已释放')
    } catch (cause) {
      setReleaseError(errorMessage(cause))
    } finally {
      setReleasing('')
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="沙箱管理"
        description="独立运行环境，清晰掌握每个任务的资源与生命周期。"
        icon="server"
        actions={<Button icon="refresh" loading={loading} onClick={() => { reload() }}>刷新状态</Button>}
      />
      <div className="grid grid-cols-3 gap-3 sm:gap-5">
        {metrics.map((metric) => (
          <div key={metric.label} className="panel px-4 py-4 sm:px-5">
            <div className="flex items-center justify-between text-xs text-txt3">
              <span>{metric.label}</span>
              <Icon name={metric.icon} size={15} className="hidden sm:inline" />
            </div>
            <p className="mt-3 text-2xl font-semibold tabular-nums">{metric.value}</p>
          </div>
        ))}
      </div>
      <div className="toolbar">
        <label className="search-input">
          <Icon name="search" size={16} />
          <input
            type="search"
            aria-label="搜索沙箱"
            placeholder="搜索沙箱名称或标识…"
            value={search}
            onChange={(event) => { setSearch(event.target.value) }}
          />
        </label>
        <Select
          className="!w-auto"
          aria-label="沙箱状态"
          value={statusFilter}
          onChange={(event) => { setStatusFilter(event.target.value) }}
        >
          <option value="">全部状态</option>
          <option value="running">使用中</option>
          <option value="released">已释放</option>
          <option value="failed">失败</option>
        </Select>
      </div>
      {releaseError ? <p role="alert" className="text-sm text-err">{releaseError}</p> : null}
      <ResourceState
        loading={loading}
        error={error}
        empty={!filtered.length}
        title={error ? undefined : '没有找到沙箱'}
        description={error ? undefined : '发起流程运行后，演示服务会自动准备对应环境。'}
        onRetry={() => { reload() }}
      />
      {!loading && !error && filtered.length ? (
        <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((item) => (
            <article key={item.id} className="panel overflow-hidden">
              <div className="flex items-start gap-3 p-5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-elevated text-txt2">
                  <Icon name="server" size={22} />
                </span>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="max-w-full truncate text-left font-semibold hover:text-accent-2"
                    onClick={() => { select(item.id) }}
                  >
                    {item.name}
                  </button>
                  <p className="mt-1 truncate font-mono text-xs text-txt3">{item.id}</p>
                </div>
                <StatusPill status={item.status} />
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-4 px-5 pb-5 text-xs">
                <div>
                  <dt className="text-txt3">镜像</dt>
                  <dd className="mt-1.5 break-all font-medium">{item.image}</dd>
                </div>
                <div>
                  <dt className="text-txt3">资源规格</dt>
                  <dd className="mt-1.5 font-medium">{item.cpu} / {item.memory}</dd>
                </div>
                <div>
                  <dt className="text-txt3">工作目录</dt>
                  <dd className="mt-1.5 break-all font-mono">{item.workspace}</dd>
                </div>
                <div>
                  <dt className="text-txt3">创建时间</dt>
                  <dd className="mt-1.5">{formatTime(item.createdAt)}</dd>
                </div>
              </dl>
              <footer className="flex flex-wrap items-center gap-2 border-t border-line bg-elevated/25 px-5 py-3">
                <Link to={`/runs/${item.runId}`} className="mr-auto text-xs font-medium text-accent-2 hover:underline">
                  查看关联运行 <span aria-hidden="true">↗</span>
                </Link>
                <Button variant="ghost" size="sm" icon="doc" onClick={() => { select(item.id) }}>详情与日志</Button>
                {item.status !== 'released' ? (
                  <Button
                    variant="danger"
                    size="sm"
                    loading={releasing === item.id}
                    onClick={() => { void release(item) }}
                  >
                    释放
                  </Button>
                ) : null}
              </footer>
            </article>
          ))}
        </div>
      ) : null}
      <p className="text-xs leading-6 text-txt3">演示环境只模拟资源状态和操作记录，不建立真实终端或远程连接。</p>
      <Modal
        open={Boolean(selected)}
        title={selected?.name}
        width={720}
        onClose={() => { select('') }}
        footer={<Button onClick={() => { select('') }}>关闭</Button>}
      >
        {selected ? (
          <>
            <div className="mb-5 flex items-center justify-between">
              <span className="font-mono text-xs text-txt3">{selected.id}</span>
              <StatusPill status={selected.status} />
            </div>
            <h3 className="mb-3 text-sm font-medium">生命周期记录</h3>
            <div className="rounded-lg border border-line bg-base p-4">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-7 text-txt2">{selected.logs.join('\n')}</pre>
            </div>
            <p className="mt-4 text-xs text-txt3">日志为本地演示事件，保留环境准备与释放记录。</p>
          </>
        ) : null}
      </Modal>
    </div>
  )
}
