import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { errorMessage } from '@/shared/api'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { Textarea } from '@/shared/ui/textarea'
import { createWorkspace, listTypes, workspacePath, type WorkspaceType } from './model'

export function NewWorkspace() {
  const navigate = useNavigate()
  const types = useResource(listTypes, [] as WorkspaceType[])
  const [typeId, setTypeId] = useState('')
  const [requirement, setRequirement] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const selected = types.data.find(type => type.id === typeId) ?? types.data[0]
  const valid = Boolean(selected) && requirement.trim() !== ''

  async function create() {
    if (!selected || !valid || busy) return
    setBusy(true)
    setError('')
    try {
      const workspace = await createWorkspace({ typeId: selected.id, requirement })
      navigate(workspacePath(workspace.id))
    } catch (cause) {
      setError(errorMessage(cause))
      setBusy(false)
    }
  }

  return <div className="page-stack break-words">
    <PageHeader title="新建线索报告工作区" description="选择类型并写明需求，创建后再准备材料"
      actions={<Button asChild><Link to="/workspaces">返回工作区</Link></Button>} />
    <ResourceState
      loading={types.loading && types.data.length === 0}
      error={types.error}
      empty={!types.loading && !types.error && types.data.length === 0}
      title={types.error ? undefined : '暂无可用的工作区类型'}
      description={types.error ? undefined : '服务端还没有注册工作区类型，稍后刷新再试。'}
      onRetry={types.reload}>
      <Button asChild><Link to="/workspaces">返回工作区</Link></Button>
    </ResourceState>
    {selected && <section className="panel space-y-5 p-4 sm:p-5">
      <label className="field">
        <span className="field-label">工作区类型</span>
        <Select aria-label="工作区类型" value={selected.id}
          onChange={event => setTypeId(event.target.value)}>
          {types.data.map(type => <option key={type.id} value={type.id}>{type.name}</option>)}
        </Select>
      </label>
      <dl className="grid gap-4 border-y border-line py-4 sm:grid-cols-2">
        <div>
          <dt className="field-label">角色材料</dt>
          <dd className="mt-1 break-words text-sm">{selected.roles.map(role => role.label).join('、') || '未声明'}</dd>
        </div>
        <div>
          <dt className="field-label">SOP</dt>
          <dd className="mt-1 break-words text-sm">
            {selected.sop.config?.title || selected.sop.id} · {selected.sop.id} v{selected.sop.revision}
          </dd>
        </div>
      </dl>
      <label className="field">
        <span className="field-label">需求</span>
        <Textarea aria-label="需求" value={requirement} rows={6}
          placeholder="写清这次要处理的线索和期望结果"
          onChange={event => { setRequirement(event.target.value); setError('') }} />
      </label>
      {error && <p role="alert" className="break-words text-sm text-err">{error} 需求已保留，可直接重试。</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void create()}>创建工作区</Button>
        <p className="text-xs text-txt3">创建后可以继续修改需求、上传各角色材料。</p>
      </div>
    </section>}
  </div>
}
