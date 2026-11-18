import { useMemo, useState } from 'react'

import { api, errorMessage } from '@/shared/api'
import type { Workflow } from '@/shared/api/types'
import { useResource } from '@/shared/hooks/use-resource'
import { confirmAction, notify } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import RunLaunchModal from './RunLaunchModal'
import { formatTime } from './definition'
import WorkflowDetail from './WorkflowDetail'
import WorkflowEditor from './WorkflowEditor'
import './workflows.css'

/** 工作流目录：加载、搜索、复制删除与编辑运行入口。 */
export default function WorkflowsView() {
  const { data, loading, error, reload } = useResource<Workflow[]>(
    (signal) => api.get<Workflow[]>('/workflows', signal),
    [],
  )
  const [search, setSearch] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Workflow | null>(null)
  const [detailId, setDetailId] = useState('')
  const [runTarget, setRunTarget] = useState<Workflow | null>(null)
  const [savingId, setSavingId] = useState('')
  const [actionError, setActionError] = useState('')

  const visible = useMemo(() => {
    const keyword = search.toLowerCase().trim()
    return data
      .filter((flow) => `${flow.name} ${flow.description}`.toLowerCase().includes(keyword))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }, [data, search])

  function edit(flow: Workflow | null = null) {
    setDetailId('')
    setEditTarget(flow)
    setEditorOpen(true)
  }

  function launch(flow: Workflow) {
    setDetailId('')
    setRunTarget(flow)
  }

  function saved() {
    setEditorOpen(false)
    void reload()
  }

  async function copy(flow: Workflow) {
    if (savingId) return
    setSavingId(flow.id)
    setActionError('')
    try {
      const accepted = await confirmAction({
        title: `复制「${flow.name}」？`,
        description: '创建一份独立的流程定义，随后可以修改名称与节点配置。',
        confirmLabel: '创建副本',
      })
      if (!accepted) return
      const copied = await api.post<Workflow>(`/workflows/${encodeURIComponent(flow.id)}/copy`)
      notify('工作流副本已创建')
      await reload()
      edit(copied)
    } catch (cause) {
      setActionError(errorMessage(cause))
    } finally {
      setSavingId('')
    }
  }

  async function remove(flow: Workflow) {
    if (savingId) return
    setSavingId(flow.id)
    setActionError('')
    try {
      const accepted = await confirmAction({
        title: `删除「${flow.name}」？`,
        description: '删除后无法从该流程创建新运行。已有运行的配置快照仍保留。',
        danger: true,
        confirmLabel: '删除工作流',
      })
      if (!accepted) return
      await api.delete(`/workflows/${encodeURIComponent(flow.id)}`)
      notify('工作流已删除')
      await reload()
    } catch (cause) {
      setActionError(errorMessage(cause))
    } finally {
      setSavingId('')
    }
  }

  return (
    <div className="page-stack page-stack-fill">
      <PageHeader
        title="工作流"
        description="管理流程定义，查看节点依赖并发起任务。"
        actions={(
          <Button variant="primary" icon="plus" onClick={() => { edit() }}>
            新建工作流
          </Button>
        )}
      />
      <div className="toolbar">
        <input
          type="search"
          className="search-input"
          placeholder="搜索工作流名称或描述…"
          aria-label="搜索工作流"
          value={search}
          onChange={(event) => { setSearch(event.target.value) }}
        />
        <div className="flex items-center gap-3">
          <span className="text-xs text-txt3">{visible.length} 个工作流</span>
          <Button variant="ghost" icon="refresh" loading={loading} onClick={reload}>刷新</Button>
        </div>
      </div>
      {actionError ? (
        <p className="rounded-lg border border-err/20 bg-err/5 px-4 py-3 text-sm text-err" role="alert">{actionError}</p>
      ) : null}
      <ResourceState
        loading={loading}
        error={error}
        empty={!visible.length}
        title={error ? undefined : search ? '没有匹配的工作流' : '创建你的第一个工作流'}
        description={
          error
            ? undefined
            : search
              ? '尝试其他关键词，或清除搜索条件。'
              : '将智能体、脚本和人工审批连接起来，形成可重复运行的流程。'
        }
        onRetry={reload}
      >
        {search ? (
          <Button variant="outline" onClick={() => { setSearch('') }}>清除搜索</Button>
        ) : (
          <Button variant="primary" icon="plus" onClick={() => { edit() }}>新建工作流</Button>
        )}
      </ResourceState>
      {!loading && !error && visible.length ? (
        <div className="table-wrap table-fill">
          <table className="data-table workflow-table">
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">节点</th>
                <th scope="col">更新时间</th>
                <th scope="col" className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((flow) => (
                <tr key={flow.id}>
                  <td className="name-cell">
                    <button type="button" className="name-button" onClick={() => { setDetailId(flow.id) }}>{flow.name}</button>
                    <p className="flow-description">{flow.description || '暂无描述'}</p>
                  </td>
                  <td className="whitespace-nowrap text-xs">{flow.nodes.length} 个节点</td>
                  <td className="whitespace-nowrap text-xs"><time dateTime={flow.updatedAt}>{formatTime(flow.updatedAt)}</time></td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" disabled={Boolean(savingId)} onClick={() => { edit(flow) }}>编辑</Button>
                      <Button variant="subtle" icon="play" disabled={Boolean(savingId)} onClick={() => { launch(flow) }}>运行</Button>
                      <Button
                        variant="ghost"
                        icon="copy"
                        disabled={Boolean(savingId)}
                        aria-label={`复制 ${flow.name}`}
                        title="复制工作流"
                        onClick={() => { void copy(flow) }}
                      />
                      <Button
                        variant="ghost"
                        icon="trash"
                        disabled={Boolean(savingId)}
                        aria-label={`删除 ${flow.name}`}
                        title="删除工作流"
                        onClick={() => { void remove(flow) }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {editorOpen ? (
        <WorkflowEditor workflow={editTarget} onClose={() => { setEditorOpen(false) }} onSaved={saved} />
      ) : null}
      {detailId ? (
        <WorkflowDetail
          key={detailId}
          id={detailId}
          onClose={() => { setDetailId('') }}
          onEdit={(flow) => { edit(flow) }}
          onRun={(flow) => { launch(flow) }}
        />
      ) : null}
      {runTarget ? <RunLaunchModal workflow={runTarget} onClose={() => { setRunTarget(null) }} /> : null}
    </div>
  )
}
