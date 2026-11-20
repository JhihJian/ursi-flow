import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { AttemptPanel } from '@/modules/agent-executor/AttemptPanel'
import { executorChoices, executorRevisions, type ExecutorRef } from '@/shared/api/agent-executor'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { getWorkPatch, type Patch } from './api'
import { patchListPath, patchPath } from './PatchModel'

export function WorkPatchExecute() {
  const { id = '' } = useParams()
  return <ExecutionPage key={id} id={id} />
}

function ExecutionPage({ id }: { id: string }) {
  const record = useResource(signal => getWorkPatch(id, signal), null)
  const patch = record.data
  return <div className="page-stack break-words">
    <PageHeader title="运行工作包" description={patch?.name} actions={<>
      {patch && <Button asChild><Link to={patchPath('work', patch.id)}>返回包详情</Link></Button>}
      <Button asChild><Link to={patchListPath('work')}>全部工作包</Link></Button>
    </>} />
    <ResourceState loading={record.loading} error={record.error} empty={!patch} onRetry={record.reload}
      title={record.error ? '读取工作包失败' : '没有找到这个工作包'} description={record.error || '请从工作包列表选择已有的包。'} />
    {!record.loading && !record.error && patch && <ExecutionForm patch={patch} />}
  </div>
}

function ExecutionForm({ patch }: { patch: Patch }) {
  const catalog = useResource(executorChoices, [])
  const enabled = catalog.data.filter(item => item.active)
  const [executorId, setExecutorId] = useState('')
  const [ref, setRef] = useState<ExecutorRef | null>(null)
  return <>
    <ResourceState loading={catalog.loading} error={catalog.error} empty={!enabled.length} onRetry={catalog.reload}
      title={catalog.error ? '读取执行器失败' : '暂无启用的执行器'} description={catalog.error || '当前没有可用于运行工作包的执行器。'} />
    {!catalog.loading && !catalog.error && enabled.length > 0 && <div className="grid items-start gap-3 sm:grid-cols-2">
      <label className="grid min-w-0 gap-1 text-sm">执行器
        <Select value={executorId} onChange={event => { setExecutorId(event.target.value); setRef(null) }}>
          <option value="">选择执行器</option>
          {enabled.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
        </Select>
      </label>
      {executorId && <RevisionPicker key={executorId} id={executorId} selected={ref} onSelect={setRef} />}
    </div>}
    <AttemptPanel target={ref ? { executorRef: ref } : null} workPatchId={patch.id} storageKey={`work-patch:${patch.id}:attempt`} />
  </>
}

function RevisionPicker({ id, selected, onSelect }: { id: string; selected: ExecutorRef | null; onSelect: (ref: ExecutorRef | null) => void }) {
  const versions = useResource(signal => executorRevisions(id, signal), [])
  if (versions.loading || versions.error || !versions.data.length) {
    return <ResourceState loading={versions.loading} error={versions.error} empty onRetry={versions.reload}
      title={versions.error ? '读取执行器修订失败' : '暂无已发布修订'} />
  }
  return <label className="grid min-w-0 gap-1 text-sm">修订
    <Select value={selected?.revision ?? ''} onChange={event => {
      const version = versions.data.find(item => String(item.revision) === event.target.value)
      onSelect(version?.agent ? { id: version.id, revision: version.revision } : null)
    }}>
      <option value="">选择修订</option>
      {versions.data.slice().reverse().map(item => <option key={item.revision} value={item.revision} disabled={!item.agent}>{item.id} @{item.revision}{!item.agent && '（通用修订，不能按版本运行）'}</option>)}
    </Select>
  </label>
}
