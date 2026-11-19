import { Link } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import {
  attemptStatus, listTypes, listWorkspaces, newWorkspacePath, workspacePath,
  type WorkspaceDetail, type WorkspaceType,
} from './model'

export function WorkspaceList() {
  const workspaces = useResource(listWorkspaces, [] as WorkspaceDetail[])
  const types = useResource(listTypes, [] as WorkspaceType[])
  const typeName = (id: string) => types.data.find(type => type.id === id)?.name ?? id
  const firstLoad = workspaces.loading && workspaces.data.length === 0

  return <div className="page-stack break-words">
    <PageHeader title="线索报告工作区" description="按需求准备材料、执行 SOP 并读取回执"
      actions={<>
        <Button icon="refresh" onClick={workspaces.reload} disabled={workspaces.loading}>刷新</Button>
        <Button variant="primary" asChild><Link to={newWorkspacePath}>新建工作区</Link></Button>
      </>} />
    <ResourceState
      loading={firstLoad}
      error={workspaces.error}
      empty={!workspaces.loading && !workspaces.error && workspaces.data.length === 0}
      title={workspaces.error ? undefined : '暂无工作区'}
      description={workspaces.error ? undefined : '新建一个工作区后，它会出现在这里。'}
      onRetry={workspaces.reload}>
      <Button variant="primary" asChild><Link to={newWorkspacePath}>新建工作区</Link></Button>
    </ResourceState>
    {!workspaces.error && workspaces.data.length > 0 && <ul className="divide-y divide-line border-y border-line">
      {workspaces.data.map(workspace => <li key={workspace.id}>
        <Link to={workspacePath(workspace.id)}
          className="flex min-w-0 flex-col gap-2 px-4 py-4 hover:bg-elevated sm:flex-row sm:items-center sm:gap-4">
          <span className="min-w-0 flex-1">
            <strong className="break-words font-medium">{workspace.requirement}</strong>
            <small className="mt-1 block break-all text-txt3">
              {typeName(workspace.typeId)} · {workspace.id}
            </small>
          </span>
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-txt2 sm:justify-end">
            <span>材料 {workspace.materials.length} 份</span>
            <span>执行 {workspace.attempts.length} 次</span>
            <span>{lastStatus(workspace)}</span>
            <span className={workspace.frozen ? 'font-medium text-txt' : 'text-txt3'}>
              {workspace.frozen ? '已冻结' : '可编辑'}
            </span>
          </span>
        </Link>
      </li>)}
    </ul>}
  </div>
}

function lastStatus(workspace: WorkspaceDetail) {
  const attempt = workspace.attempts.at(-1)
  if (!attempt) return '尚未执行'
  return `最近${attemptStatus[attempt.status]}`
}
