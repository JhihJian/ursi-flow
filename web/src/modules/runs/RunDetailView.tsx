import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'

import type { NodeRun, RunEvent } from '@/shared/api/types'
import { confirmAction, notify } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { Label } from '@/shared/ui/label'
import { Modal } from '@/shared/ui/modal'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { StatusPill } from '@/shared/ui/status-pill'
import { TabBar } from '@/shared/ui/tabs'
import { RunSnapshot } from './RunSnapshot'
import { completedAncestors, formatTime, isTerminal } from './runState'
import { useRunDetail } from './useRunDetail'

const tabs = [
  { id: 'activity', label: '执行过程' },
  { id: 'input', label: '任务输入' },
  { id: 'snapshot', label: '配置快照' },
  { id: 'artifacts', label: '交付产物' },
]

const eventLabels: Record<RunEvent['type'], string> = { state: '状态', log: '日志', tool: '工具' }
const nodeLabels: Record<NodeRun['type'], string> = { agent: '智能体', approval: '人工审批', script: '脚本' }

function fileSize(size: number) {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`
}

/** 运行详情：节点进度、事件日志、冻结配置、产物与人工审批。 */
export default function RunDetailView() {
  const params = useParams()
  const id = params.id ?? ''
  // 标识变化时重建视图状态与轮询，旧运行的选中节点、弹窗和事件序号不残留。
  return <RunDetail id={id} key={id} />
}

function RunDetail({ id }: { id: string }) {
  const { run, events, artifacts, loading, refreshing, error, artifactError, actionError, saving, refresh, act } = useRunDetail(id)
  const [tab, setTab] = useState('activity')
  const [selectedNode, setSelectedNode] = useState('')
  const [eventKind, setEventKind] = useState('')
  const [rejectOpen, setRejectOpen] = useState(false)
  const [targetNodeId, setTargetNodeId] = useState('')
  const [rejectError, setRejectError] = useState('')
  const [confirming, setConfirming] = useState(false)

  const ancestors = useMemo(() => (run ? completedAncestors(run) : []), [run])
  const lastEventAt = useMemo(() => {
    const map: Record<string, string> = {}
    for (const event of events) if (event.nodeId) map[event.nodeId] = event.at
    return map
  }, [events])

  const approval = run?.nodes.find((node) => node.status === 'waiting_approval')
  const selected = run?.nodes.find((node) => node.id === selectedNode)
  const visibleEvents = events.filter((event) => (!selectedNode || event.nodeId === selectedNode) && (!eventKind || event.type === eventKind))
  const completedCount = run ? run.nodes.filter((node) => node.status === 'succeeded').length : 0
  const busy = saving || confirming

  async function approve() {
    if (busy || !run) return
    if (await act('approve')) notify('审批已通过')
  }

  function openReject() {
    if (busy) return
    setTargetNodeId(ancestors[0]?.id ?? '')
    setRejectError('')
    setRejectOpen(true)
  }

  async function reject() {
    if (busy) return
    if (!ancestors.some((node) => node.id === targetNodeId)) {
      setRejectError('请选择已完成的上游祖先节点。')
      return
    }
    if (await act('reject', { targetNodeId })) {
      setRejectOpen(false)
      notify('已打回，新的执行轮次已创建')
    }
  }

  async function cancel() {
    if (busy || !run) return
    setConfirming(true)
    try {
      const accepted = await confirmAction({
        title: '取消这次运行？',
        description: '确认后请求停止执行，已产生的事件与产物会保留。',
        danger: true,
        confirmLabel: '取消运行',
      })
      if (accepted && await act('cancel')) notify('取消请求已处理')
    } finally {
      setConfirming(false)
    }
  }

  function selectNode(nodeId: string) {
    setSelectedNode(selectedNode === nodeId ? '' : nodeId)
    setTab('activity')
  }

  return (
    <div className="page-stack">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to="/runs" className="inline-flex items-center gap-1 text-xs text-txt3 hover:text-accent-2">
          <Icon name="chevron-left" size={14} />运行记录
        </Link>
        {run && !isTerminal(run.status) ? (
          <span className="inline-flex items-center gap-2 text-xs text-txt3">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />每 1.5 秒更新
          </span>
        ) : run ? <span className="text-xs text-txt3">运行已结束</span> : null}
      </div>

      <PageHeader
        title={run?.name || '运行详情'}
        description={run?.workflowName || '查看运行状态、执行过程与配置快照。'}
        actions={(
          <>
            <Button variant="ghost" icon="refresh" loading={refreshing} disabled={busy} onClick={refresh}>刷新</Button>
            {run && !isTerminal(run.status) ? <Button variant="outline" disabled={busy} onClick={() => { void cancel() }}>取消运行</Button> : null}
          </>
        )}
      />

      {run ? null : <ResourceState loading={loading} error={error} onRetry={refresh} />}
      {error && run ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-err/20 bg-err/5 px-4 py-3 text-xs text-err" role="alert">
          <span>更新失败，当前显示上次读取的状态。{error}</span>
          <Button variant="ghost" onClick={refresh}>重试</Button>
        </div>
      ) : null}
      {actionError && !rejectOpen ? <p className="rounded-lg border border-err/20 bg-err/5 px-4 py-3 text-xs text-err" role="alert">{actionError}</p> : null}

      {run ? (
        <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_288px]">
          <main className="min-w-0 space-y-5" aria-label="运行内容">
            {run.status === 'waiting' && approval ? (
              <section className="rounded-xl border border-accent/30 bg-surface p-5">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="rounded-lg bg-accent-dim p-2 text-accent-2"><Icon name="gate" size={19} /></span>
                  <div>
                    <h2 className="text-sm font-semibold">等待人工审批</h2>
                    <p className="mt-1 text-xs leading-6 text-txt3">「{approval.name}」需要你的决定。查看上游输出后，可以放行或打回返工。</p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <Button variant="outline" disabled={busy || !ancestors.length} onClick={openReject}>打回返工</Button>
                  <Button variant="primary" icon="check" loading={saving} disabled={confirming} onClick={() => { void approve() }}>通过审批</Button>
                </div>
                {ancestors.length ? null : <p className="mt-2 text-xs text-txt3">当前没有已完成的上游节点可供打回。</p>}
              </section>
            ) : null}

            <section className="panel overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-4">
                <h2 className="text-[13px] font-semibold">节点步骤</h2>
                <span className="text-[11px] text-txt3">第 {run.attempt} 次执行 · {completedCount}/{run.nodes.length} 完成</span>
              </div>
              <ol className="p-2">
                {run.nodes.map((node, index) => {
                  const time = lastEventAt[node.id]
                  const selectedRow = selectedNode === node.id
                  return (
                    <li key={node.id}>
                      <button
                        type="button"
                        className={`flex w-full items-center gap-3 rounded-lg p-3 text-left ${selectedRow ? 'bg-elevated/70' : 'hover:bg-elevated/70'}`}
                        aria-pressed={selectedRow}
                        onClick={() => { selectNode(node.id) }}
                      >
                        <span
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] ${
                            node.status === 'succeeded'
                              ? 'border-accent/25 bg-accent-dim text-accent-2'
                              : node.status === 'running' || node.status === 'waiting_approval'
                                ? 'border-accent text-accent-2'
                                : 'border-line-strong text-txt3'
                          }`}
                        >
                          {node.status === 'succeeded' ? <Icon name="check" size={14} /> : index + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{node.name}</span>
                          <span className="mt-0.5 block text-xs text-txt3">
                            {nodeLabels[node.type]}
                            {node.roleId ? ` · ${run.snapshot.roles.find((role) => role.id === node.roleId)?.name || node.roleId}` : ''}
                          </span>
                        </span>
                        {time ? <time dateTime={time} className="hidden text-[11px] text-txt3 sm:block">{formatTime(time)}</time> : null}
                        <StatusPill status={node.status} />
                      </button>
                    </li>
                  )
                })}
              </ol>
              {selected ? (
                <div className="border-t border-line bg-elevated/30 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-xs font-medium">{selected.name} · 当前输出</h3>
                    <button type="button" className="text-xs text-accent-2" onClick={() => { setSelectedNode('') }}>显示全部节点</button>
                  </div>
                  <pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-6 text-txt3">{selected.output || '当前节点尚未产生输出。'}</pre>
                </div>
              ) : null}
            </section>

            <section className="panel overflow-hidden">
              <div className="border-b border-line px-4 pt-2">
                <TabBar tabs={tabs} value={tab} onValueChange={setTab} />
              </div>
              {tab === 'activity' ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                    <span className="text-xs text-txt3">{selected ? selected.name : '全部节点'} · {visibleEvents.length} 条事件</span>
                    <Select aria-label="筛选事件类型" className="!w-auto !py-1 !text-xs" value={eventKind} onChange={(event) => { setEventKind(event.target.value) }}>
                      <option value="">全部事件</option>
                      <option value="state">状态变化</option>
                      <option value="tool">工具轨迹</option>
                      <option value="log">执行日志</option>
                    </Select>
                  </div>
                  {visibleEvents.length ? (
                    <ol className="event-list max-h-[560px] overflow-auto py-1" aria-label="运行事件日志">
                      {visibleEvents.map((event) => (
                        <li key={event.id} className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 border-b border-line/50 px-5 py-3 last:border-b-0">
                          <span className="pt-0.5 font-mono text-[10px] text-txt3">{String(event.sequence).padStart(3, '0')}</span>
                          <div className="min-w-0">
                            <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] text-txt3">
                              <time dateTime={event.at}>{formatTime(event.at)}</time>
                              <span className="rounded-[3px] bg-elevated px-[5px]">{eventLabels[event.type]}</span>
                              {event.nodeId ? <span>{run.nodes.find((node) => node.id === event.nodeId)?.name || event.nodeId}</span> : null}
                            </div>
                            <p className="whitespace-pre-wrap break-words text-xs leading-6 text-txt2">{event.message}</p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  ) : <div className="empty-hint">暂无符合条件的事件，运行更新后会显示在这里。</div>}
                </>
              ) : null}

              {tab === 'input' ? (
                <div className="p-5">
                  <h2 className="mb-3 text-sm font-medium">任务输入</h2>
                  <pre className="whitespace-pre-wrap break-words text-sm leading-7 text-txt2">{run.input || '无任务输入'}</pre>
                </div>
              ) : null}

              {tab === 'snapshot' ? <div className="p-5"><RunSnapshot snapshot={run.snapshot} /></div> : null}

              {tab === 'artifacts' ? (
                <div className="p-4">
                  <div className="mb-4 flex items-center justify-between gap-2">
                    <p className="text-xs text-txt3">保留当前与历史轮次的交付产物。</p>
                    <Link to={`/artifacts?runId=${encodeURIComponent(run.id)}`} className="text-xs text-accent-2">查看全部产物</Link>
                  </div>
                  {artifactError ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-err/20 bg-err/5 px-4 py-3 text-xs text-err" role="alert">
                      {artifactError}
                      <Button variant="ghost" onClick={refresh}>重试</Button>
                    </div>
                  ) : artifacts.length ? (
                    <ul className="divide-y divide-line">
                      {artifacts.map((artifact) => (
                        <li key={artifact.id} className="flex items-center gap-3 py-3">
                          <Icon name="doc" size={18} className="shrink-0 text-txt3" />
                          <div className="min-w-0 flex-1">
                            <Link
                              to={`/artifacts?runId=${encodeURIComponent(run.id)}&id=${encodeURIComponent(artifact.id)}`}
                              className="block truncate text-sm font-medium hover:text-accent-2"
                            >
                              {artifact.name}
                            </Link>
                            <p className="mt-1 text-xs text-txt3">
                              第 {artifact.attempt} 次执行 · {run.nodes.find((node) => node.id === artifact.nodeId)?.name || artifact.nodeId} · {fileSize(artifact.size)}
                            </p>
                          </div>
                          <time className="hidden text-xs text-txt3 sm:block" dateTime={artifact.createdAt}>{formatTime(artifact.createdAt)}</time>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="empty-hint">尚未产生交付物。</p>}
                </div>
              ) : null}
            </section>
          </main>

          <aside className="space-y-4" aria-label="运行摘要">
            <section className="panel p-5">
              <div className="mb-5 flex items-center justify-between">
                <h2 className="text-sm font-semibold">运行摘要</h2>
                <StatusPill status={run.status} />
              </div>
              <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-4 text-xs">
                <dt className="text-txt3">运行标识</dt>
                <dd className="break-words font-mono text-[11px]">{run.id}</dd>
                <dt className="text-txt3">工作流</dt>
                <dd className="break-words">{run.workflowName}</dd>
                <dt className="text-txt3">执行轮次</dt>
                <dd>第 {run.attempt} 次</dd>
                <dt className="text-txt3">创建时间</dt>
                <dd>{formatTime(run.createdAt)}</dd>
                <dt className="text-txt3">最近更新</dt>
                <dd>{formatTime(run.updatedAt)}</dd>
                <dt className="text-txt3">节点完成</dt>
                <dd>{completedCount} / {run.nodes.length}</dd>
              </dl>
            </section>
            <section className="panel p-4">
              <h2 className="mb-3 text-xs font-semibold text-txt3">关联资源</h2>
              <Link to={`/artifacts?runId=${encodeURIComponent(run.id)}`} className="flex items-center justify-between gap-2 rounded px-1 py-2.5 text-xs text-txt2 hover:text-accent-2">
                <span className="flex items-center gap-2"><Icon name="folder" size={16} />交付产物</span>
                <span className="flex items-center gap-2">{artifactError ? '查看' : artifacts.length}<Icon name="chevron-right" size={14} /></span>
              </Link>
              {run.sandboxId ? (
                <Link to={`/sandboxes?id=${encodeURIComponent(run.sandboxId)}`} className="flex items-center justify-between gap-2 rounded px-1 py-2.5 text-xs text-txt2 hover:text-accent-2">
                  <span className="flex items-center gap-2"><Icon name="terminal" size={16} />运行沙箱</span>
                  <Icon name="chevron-right" size={14} />
                </Link>
              ) : null}
              <button type="button" className="flex w-full items-center justify-between gap-2 rounded px-1 py-2.5 text-xs text-txt2 hover:text-accent-2" onClick={() => { setTab('snapshot') }}>
                <span className="flex items-center gap-2"><Icon name="settings" size={16} />配置快照</span>
                <Icon name="chevron-right" size={14} />
              </button>
            </section>
          </aside>
        </div>
      ) : null}

      <Modal
        open={rejectOpen}
        title="打回上游节点"
        width={520}
        onClose={() => { if (!saving) setRejectOpen(false) }}
        footer={(
          <>
            <Button variant="ghost" disabled={saving} onClick={() => { setRejectOpen(false) }}>取消</Button>
            <Button variant="primary" type="submit" form="reject-run" loading={saving} disabled={!ancestors.length || run?.status !== 'waiting'}>确认打回</Button>
          </>
        )}
      >
        <form id="reject-run" className="space-y-4" onSubmit={(event) => { event.preventDefault(); void reject() }}>
          <p className="text-sm leading-6 text-txt3">选择已完成的上游环节。该节点及其下游将重新执行，历史事件和产物会保留。</p>
          <div className="field">
            <Label htmlFor="reject-target">返工目标 <span className="text-err">*</span></Label>
            <Select
              id="reject-target"
              value={targetNodeId}
              disabled={saving}
              required
              onChange={(event) => { setTargetNodeId(event.target.value) }}
            >
              <option value="" disabled>请选择上游节点</option>
              {ancestors.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
            </Select>
          </div>
          {ancestors.length ? null : <p className="text-xs text-txt3">状态已变化，当前没有可用的返工目标。请关闭后查看最新状态。</p>}
          {rejectError || actionError ? <p className="text-sm text-err" role="alert">{rejectError || actionError}</p> : null}
        </form>
      </Modal>
    </div>
  )
}
