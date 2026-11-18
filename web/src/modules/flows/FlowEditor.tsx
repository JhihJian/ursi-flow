import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { errorMessage, runtime } from '@/shared/api'
import type { FlowPackage } from '@/shared/api/types'
import { useResource } from '@/shared/hooks/use-resource'
import { confirmAction } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { PackageFiles } from './PackageFiles'
import { StartRun } from './StartRun'

const template = `---
name: 任务处理
description: 执行任务并记录结果。
---

\`\`\`mermaid
flowchart TD
  start((开始)) --> task[处理任务]
  task -->|已完成| finish((结束))
\`\`\`

## 处理任务

\`\`\`新建Agent
完成任务并汇报结果。
\`\`\`

### 已完成

已得到处理结果。
`
export function FlowEditor() {
  const { id } = useParams()
  return id ? <LoadEditor key={id} id={id} /> : <Editor />
}
function LoadEditor({ id }: { id: string }) {
  const resource = useResource<FlowPackage | null>(s => runtime.flow(id, s), null)
  return resource.data ? <Editor initial={resource.data} /> : <ResourceState {...resource} onRetry={resource.reload} />
}
function Editor({ initial }: { initial?: FlowPackage }) {
  const navigate = useNavigate()
  const [id, setId] = useState(initial?.id ?? '')
  const [saved, setSaved] = useState(initial)
  const [files, setFiles] = useState(initial?.files ?? { 'FLOW.md': template })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const dirty = saved?.files !== files
  async function action(op: 'validate' | 'save' | 'delete') {
    setError(''); setMessage('')
    if (!/^[A-Za-z0-9][\w-]{0,95}$/.test(id)) { setError('Flow ID 须以字母或数字开头，只可含字母、数字、下划线和短横线，最长 96 字符。'); return }
    if (op === 'delete' && !await confirmAction({ title: '删除 Flow 包？', description: `将删除 ${id} 及其中全部文件。`, danger: true, confirmLabel: '删除' })) return
    setBusy(true)
    try {
      if (op === 'delete') { await runtime.remove(id); navigate('/flows', { replace: true }); return }
      if (op === 'validate') {
        const result = await runtime.validate(id, files)
        if (!result.valid) throw new Error('包验证未通过。')
        setMessage('包验证通过。'); return
      }
      if (saved) {
        const revision = await runtime.update(id, files, saved.revision)
        setSaved({ ...revision, files }); setMessage('已保存。')
      } else {
        const created = await runtime.create(id, files)
        navigate(`/flows/${encodeURIComponent(created.id)}/edit`, { replace: true })
      }
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <div className="page-stack">
    <PageHeader title={initial ? '编辑 Flow' : '创建 Flow'} actions={<Button asChild><Link to="/flows">返回目录</Link></Button>} />
    <fieldset disabled={busy} className="panel space-y-5 p-5">
      <label className="field"><span className="field-label">Flow ID</span><Input readOnly={!!initial} value={id} onChange={e => { setId(e.target.value); setMessage('') }} /></label>
      {saved && <p className="break-all text-xs text-txt3">Revision：{saved.revision}</p>}
      <PackageFiles files={files} onChange={value => { setFiles(value); setMessage(''); setError('') }} />
      {error && <p role="alert" className="break-words text-sm text-err">{error}</p>}{message && <p role="status" className="text-sm text-ok">{message}</p>}
      <div className="flex flex-wrap gap-2"><Button icon="check" onClick={() => void action('validate')}>验证包</Button><Button variant="primary" disabled={!dirty} onClick={() => void action('save')}>保存 Flow</Button>
        {saved && <Button className="ml-auto" variant="danger" onClick={() => void action('delete')}>删除 Flow</Button>}
      </div>
    </fieldset>{saved && <StartRun id={id} disabled={busy || dirty} />}
  </div>
}
