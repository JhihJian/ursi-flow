import { api } from '@/shared/api'
import type { Role, Workflow } from '@/shared/api/types'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Modal } from '@/shared/ui/modal'
import { ResourceState } from '@/shared/ui/resource-state'
import WorkflowDiagram from './WorkflowDiagram'
import { formatTime } from './definition'

export interface WorkflowDetailProps {
  id: string
  onClose: () => void
  onEdit: (workflow: Workflow) => void
  onRun: (workflow: Workflow) => void
}

/** 工作流详情弹窗：描述、统计与只读依赖图。 */
export default function WorkflowDetail({ id, onClose, onEdit, onRun }: WorkflowDetailProps) {
  const { data, loading, error, reload } = useResource<Workflow | null>(
    (signal) => api.get<Workflow>(`/workflows/${encodeURIComponent(id)}`, signal),
    null,
  )
  const roles = useResource<Role[]>((signal) => api.get<Role[]>('/roles', signal), [])
  const disabled = !data || loading || Boolean(error)

  return (
    <Modal
      open
      title={data?.name || '工作流详情'}
      width={960}
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          <Button icon="edit" disabled={disabled} onClick={() => { if (data) onEdit(data) }}>编辑定义</Button>
          <Button variant="primary" icon="play" disabled={disabled} onClick={() => { if (data) onRun(data) }}>运行</Button>
        </>
      )}
    >
      <ResourceState loading={loading} error={error} onRetry={reload} />
      {data && !loading && !error ? (
        <div className="space-y-5">
          <p className="text-sm leading-6 text-txt3">{data.description || '暂无描述'}</p>
          <div className="flex flex-wrap gap-4 text-xs text-txt3">
            <span>{data.nodes.length} 个节点</span>
            <span>{data.edges.length} 条连线</span>
            <span>更新于 {formatTime(data.updatedAt)}</span>
          </div>
          <div className="overflow-hidden rounded-lg border border-line">
            <WorkflowDiagram workflow={data} roles={roles.data} />
          </div>
          {roles.error ? (
            <p className="text-xs text-txt3">
              角色名称暂时无法加载，节点仍显示角色标识。
              <button type="button" className="text-accent-2" onClick={roles.reload}>重试</button>
            </p>
          ) : null}
        </div>
      ) : null}
    </Modal>
  )
}
