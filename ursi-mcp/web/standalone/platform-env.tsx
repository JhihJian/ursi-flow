import { useId, useState, type FormEvent } from 'react'
import { useMutation } from '../src/lib/use-mutation'
import { useResource } from '../src/lib/use-resource'
import { Button } from '../src/ui/button'
import { useFeedback } from '../src/ui/feedback'
import { Input } from '../src/ui/input'
import { Modal } from '../src/ui/modal'
import { PageHeader } from '../src/ui/page-header'
import { ResourceState } from '../src/ui/resource-state'
import { request } from './session'

export const variablePath = '/platform-env'
export const listVariableNames = (signal: AbortSignal) => request<string[]>(variablePath, { signal })

type Action = { kind: 'create' } | { kind: 'replace' | 'delete'; name: string }

function saveVariable(action: Action, name: string, value: string, signal: AbortSignal) {
  if (action.kind === 'create') {
    return request<{ name: string }>(variablePath, { method: 'POST', body: JSON.stringify({ name, value }), signal })
  }
  const path = `${variablePath}/${encodeURIComponent(action.name)}`
  return request<{ name: string }>(path, action.kind === 'delete' ? { method: 'DELETE', signal }
    : { method: 'PUT', body: JSON.stringify({ value }), signal })
}

function VariableDialog({ action, close, saved }: { action: Action; close: () => void; saved: () => void }) {
  const form = useId()
  const change = useMutation()
  const [name, setName] = useState(action.kind === 'create' ? '' : action.name)
  const [value, setValue] = useState('')
  const creating = action.kind === 'create'
  const deleting = action.kind === 'delete'
  const title = creating ? '新增变量' : deleting ? '删除变量' : '替换变量值'

  function submit(event: FormEvent) {
    event.preventDefault()
    void change.run(signal => saveVariable(action, name, value, signal), saved)
  }

  return <Modal open title={title} onClose={() => { if (!change.busy) close() }} closeOnEsc={!change.busy} closeOnBackdrop={false} footer={<>
    <Button autoFocus={deleting} disabled={change.busy} onClick={close}>取消</Button>
    <Button variant={deleting ? 'danger' : 'primary'} type="submit" form={form} loading={change.busy}>{deleting ? '确认删除' : '保存'}</Button>
  </>}>
    <form id={form} method="post" onSubmit={submit} autoComplete="off">
      <fieldset className="host-fields" disabled={change.busy}>
        {deleting ? <p>删除 <code>{name}</code> 后，引用该变量的 MCP 服务将无法建立新连接。</p> : <>
          <label className="host-field">
            <span>变量名</span>
            <Input autoFocus={creating} required readOnly={!creating} pattern="[A-Z][A-Z0-9_]*" maxLength={128}
              title="以大写字母开头，仅使用大写字母、数字和下划线" spellCheck={false} autoCapitalize="none"
              placeholder="MCP_SERVICE_TOKEN" value={name} onChange={event => setName(event.target.value)} />
          </label>
          <label className="host-field">
            <span>新值</span>
            <Input autoFocus={!creating} required type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none"
              maxLength={8192} value={value} onChange={event => setValue(event.target.value)} />
          </label>
          <p className="host-muted">保存后无法查看原值。</p>
        </>}
        {change.error && <p role="alert" className="host-error">{change.error}</p>}
      </fieldset>
    </form>
  </Modal>
}

export function PlatformEnvironment() {
  const variables = useResource(listVariableNames, [])
  const { notify } = useFeedback()
  const [action, setAction] = useState<Action | null>(null)
  return <div className="page-stack">
    <PageHeader title="环境变量" actions={<>
      <Button icon="refresh" loading={variables.loading} onClick={variables.reload}>刷新</Button>
      <Button icon="plus" variant="primary" onClick={() => setAction({ kind: 'create' })}>新增变量</Button>
    </>} />
    {variables.loading || variables.error || !variables.data.length ?
      <ResourceState loading={variables.loading} error={variables.error} onRetry={variables.reload} empty title={variables.error ? undefined : '暂无平台变量'} /> :
      <ul aria-label="平台环境变量" className="host-variable-list">
        {variables.data.map(name => <li key={name} className="host-variable-row">
          <code>{name}</code>
          <div className="host-variable-actions">
            <Button onClick={() => setAction({ kind: 'replace', name })}>替换值</Button>
            <Button icon="trash" variant="ghost" size="icon" title={`删除 ${name}`} aria-label={`删除 ${name}`}
              onClick={() => setAction({ kind: 'delete', name })} />
          </div>
        </li>)}
      </ul>}
    {action && <VariableDialog action={action} close={() => setAction(null)} saved={() => {
      setAction(null)
      variables.reload()
      notify(action.kind === 'delete' ? '变量已删除' : '变量已保存')
    }} />}
  </div>
}
