import { useState } from 'react'
import { executorChoices, executorRevisions, type ExecutorRef } from '@/shared/api/agent-executor'
import { useResource } from '@/shared/hooks/use-resource'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'

type Props = { selected: ExecutorRef | null; onSelect: (ref: ExecutorRef | null) => void }

export function ExecutorRefPicker({ selected, onSelect }: Props) {
  const catalog = useResource(executorChoices, [])
  const enabled = catalog.data.filter(item => item.active)
  const [id, setId] = useState('')
  if (catalog.loading || catalog.error || !enabled.length) return <ResourceState loading={catalog.loading} error={catalog.error} empty onRetry={catalog.reload}
    title={catalog.error ? '读取执行器失败' : '暂无启用的执行器'} />
  return <div className="grid items-start gap-3 sm:grid-cols-2">
    <label className="field">执行器<Select value={id} onChange={event => { setId(event.target.value); onSelect(null) }}>
      <option value="">选择执行器</option>
      {enabled.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
    </Select></label>
    {id && <RevisionPicker key={id} id={id} selected={selected} onSelect={onSelect} />}
  </div>
}

function RevisionPicker({ id, selected, onSelect }: Props & { id: string }) {
  const versions = useResource(signal => executorRevisions(id, signal), [])
  if (versions.loading || versions.error || !versions.data.length) return <ResourceState loading={versions.loading} error={versions.error} empty onRetry={versions.reload}
    title={versions.error ? '读取执行器修订失败' : '暂无已发布修订'} />
  return <label className="field">修订<Select value={selected?.revision ?? ''} onChange={event => {
    const version = versions.data.find(item => String(item.revision) === event.target.value)
    onSelect(version?.agent ? { id, revision: version.revision } : null)
  }}>
    <option value="">选择修订</option>
    {versions.data.slice().reverse().map(item => <option key={item.revision} value={item.revision} disabled={!item.agent}>{item.id} @{item.revision}{!item.agent && '（通用修订，不能按版本运行）'}</option>)}
  </Select></label>
}
