import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { AttemptPanel } from '@/modules/agent-executor/AttemptPanel'
import { ExecutorRefPicker } from '@/modules/agent-executor/ExecutorRefPicker'
import type { ExecutorRef } from '@/shared/api/agent-executor'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
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
  const [ref, setRef] = useState<ExecutorRef | null>(null)
  return <>
    <ExecutorRefPicker selected={ref} onSelect={setRef} />
    <AttemptPanel target={ref ? { executorRef: ref } : null} workPatchId={patch.id} storageKey={`work-patch:${patch.id}:attempt`} />
  </>
}
