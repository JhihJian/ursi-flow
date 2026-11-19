import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { errorMessage } from '@/shared/api'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Textarea } from '@/shared/ui/textarea'
import {
  attemptStatus, formatSize, lastAttempt, materialOf, readWorkspace, removeMaterial, resultPath,
  runAttempt, updateRequirement, uploadMaterial, type WorkspaceDetail, type WorkspaceSopRef,
} from './model'
import { RunControl } from './RunControl'

type Busy = '' | 'save' | 'run' | `upload:${string}` | `remove:${string}`

export function WorkspacePrepare() {
  const { id = '' } = useParams()
  const result = useResource(signal => readWorkspace(id, signal), null)
  return <div className="page-stack break-words">
    <PageHeader title="准备工作包" description={result.data ? `${result.data.typeId} · ${id}` : id}
      actions={<>
        <Button asChild><Link to="/workspaces">返回工作包</Link></Button>
        <Button icon="refresh" onClick={result.reload} disabled={result.loading}>刷新</Button>
      </>} />
    {result.data
      ? <Prepare key={JSON.stringify(result.data)} initial={result.data} />
      : <ResourceState loading={result.loading} error={result.error} onRetry={result.reload} />}
  </div>
}

function Prepare({ initial }: { initial: WorkspaceDetail }) {
  const navigate = useNavigate()
  const [workspace, setWorkspace] = useState(initial)
  const [draft, setDraft] = useState(initial.requirement)
  const [files, setFiles] = useState<Record<string, File>>({})
  const [busy, setBusy] = useState<Busy>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const frozen = workspace.frozen
  const dirty = draft !== workspace.requirement
  const latest = lastAttempt(workspace)
  const missingRoles = workspace.roles.filter(role => !materialOf(workspace, role.id))

  function chooseFile(role: string, file: File | undefined) {
    setFiles(previous => {
      const next = { ...previous }
      if (file) next[role] = file
      else delete next[role]
      return next
    })
    setError('')
    setNotice('')
  }

  async function save(): Promise<WorkspaceDetail | null> {
    if (frozen) return null
    if (!draft.trim()) {
      setError('需求不能为空。')
      return null
    }
    setBusy('save')
    setError('')
    setNotice('')
    try {
      const next = await updateRequirement(workspace.id, draft)
      setWorkspace(next)
      setNotice('需求已保存。')
      return next
    } catch (cause) {
      setError(errorMessage(cause))
      return null
    } finally {
      setBusy('')
    }
  }

  async function upload(role: string) {
    const file = files[role]
    if (!file || frozen || busy) return
    setBusy(`upload:${role}`)
    setError('')
    setNotice('')
    try {
      const next = await uploadMaterial(workspace.id, role, file.name, file)
      setWorkspace(next)
      chooseFile(role, undefined)
      setNotice(`${file.name} 已上传。`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  /** 撤回只在首次执行前可用，成功后该角色空出来可以重传。 */
  async function withdraw(role: string) {
    const material = materialOf(workspace, role)
    if (!material || frozen || busy) return
    setBusy(`remove:${role}`)
    setError('')
    setNotice('')
    try {
      const next = await removeMaterial(workspace.id, role)
      setWorkspace(next)
      chooseFile(role, undefined)
      setNotice(`${material.name} 已撤回，可以重新上传。`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }

  async function execute(sop: WorkspaceSopRef) {
    if (busy) return
    setError('')
    setNotice('')
    // 执行按钮先保存已编辑的需求，保存失败就不发起执行。
    if (!frozen && dirty) {
      const saved = await save()
      if (!saved) return
    }
    setBusy('run')
    try {
      await runAttempt(workspace.id, sop)
      navigate(resultPath(workspace.id))
    } catch (cause) {
      setError(`执行请求未完成：${errorMessage(cause)}`)
      setBusy('')
    }
  }

  return <>
    <section className="panel space-y-3 p-4 sm:p-5">
      <h2 className="font-semibold">需求</h2>
      {frozen && <p className="border-l-2 border-warn pl-3 text-sm text-txt2">
        工作包已冻结：需求和材料不可修改，仍可重新执行。
      </p>}
      <label className="field">
        <span className="field-label">需求</span>
        <Textarea aria-label="需求" value={draft} rows={6} disabled={frozen}
          onChange={event => { setDraft(event.target.value); setError(''); setNotice('') }} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button loading={busy === 'save'} disabled={frozen || !dirty || busy !== ''} onClick={() => void save()}>
          保存需求
        </Button>
        {dirty && !frozen && <span className="text-xs text-txt3">需求有未保存的修改。</span>}
      </div>
    </section>

    <section className="panel space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">角色材料</h2>
        <p className="text-xs text-txt3">已收存 {workspace.materials.length} / {workspace.roles.length} 份 · 每份最多 16 MiB</p>
      </div>
      {workspace.roles.length === 0 && <p className="text-sm text-txt2">该类型没有声明材料角色。</p>}
      {workspace.roles.map(role => {
        const material = materialOf(workspace, role.id)
        const chosen = files[role.id]
        return <div key={role.id} className="min-w-0 space-y-2 border-t border-line pt-3">
          <fieldset className="min-w-0 space-y-2" disabled={frozen || Boolean(material)}>
            <legend className="font-medium">{role.label}</legend>
            <p className="break-words text-sm text-txt2">
              {material ? `${material.name} · ${formatSize(material.size)}` : '尚未上传'}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="field min-w-0 flex-1">
                <span className="field-label">选择{role.label}材料文件</span>
                <input className="input" type="file" aria-label={`选择${role.label}材料文件`}
                  onChange={event => chooseFile(role.id, event.target.files?.[0])} />
              </label>
              <Button size="sm" className="sm:mb-0.5" disabled={!chosen || busy !== ''}
                loading={busy === `upload:${role.id}`}
                aria-label={`上传${role.label}材料`} onClick={() => void upload(role.id)}>
                上传材料
              </Button>
            </div>
          </fieldset>
          {material && !frozen && workspace.attempts.length === 0 && <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy !== ''} loading={busy === `remove:${role.id}`}
              aria-label={`撤回${role.label}材料`} onClick={() => void withdraw(role.id)}>
              撤回重传
            </Button>
            <span className="text-xs text-txt3">上传有误可在首次执行前撤回后重传。</span>
          </div>}
        </div>
      })}
    </section>

    <section className="panel space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">执行</h2>
          <p className="mt-1 text-sm text-txt2">
            {latest
              ? `${workspace.attempts.length} 次执行 · 最近${attemptStatus[latest.status]}`
              : '尚未执行'}
          </p>
        </div>
        <Button asChild><Link to={resultPath(workspace.id)}>查看结果与回执</Link></Button>
      </div>
      <RunControl typeId={workspace.typeId} running={busy === 'run'}
        disabled={busy !== '' || !draft.trim() || (!frozen && missingRoles.length > 0)}
        onRun={execute} />
      {missingRoles.length > 0 && <p className="text-sm text-warn">
        执行前还需上传：{missingRoles.map(role => role.label).join('、')}。服务端会校验材料是否齐全。
      </p>}
      {!frozen && <p className="text-xs text-txt3">执行前会先保存已编辑的需求；执行失败也会留下尝试记录。</p>}
    </section>

    {notice && <p role="status" className="border-l-2 border-ok pl-3 text-sm text-txt2">{notice}</p>}
    {error && <p role="alert" className="break-words border-l-2 border-err pl-3 text-sm text-err">
      {error} 已填写的内容仍保留，可直接重试。
    </p>}
  </>
}
