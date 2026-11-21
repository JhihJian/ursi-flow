import { useId, useState, type FormEvent } from 'react'
import { createVariable, deleteVariable, listVariables, replaceVariable } from '@/shared/api/platform-env'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { notify } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/modal'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'

type Action = { type: 'create' } | { type: 'replace' | 'delete'; name: string }

function VariableDialog({ action, close, saved }: { action: Action; close: () => void; saved: () => void }) {
  const form = useId()
  const change = useMutation()
  const [name, setName] = useState(action.type === 'create' ? '' : action.name)
  const [value, setValue] = useState('')
  const deleting = action.type === 'delete'
  const title = deleting ? '删除变量' : action.type === 'create' ? '新增变量' : '替换变量值'
  function submit(e: FormEvent) {
    e.preventDefault()
    void change.run(signal => deleting ? deleteVariable(name, signal) : action.type === 'create'
      ? createVariable(name, value, signal) : replaceVariable(name, value, signal), saved)
  }
  return <Modal open title={title} onClose={() => { if (!change.busy) close() }} closeOnEsc={!change.busy} closeOnBackdrop={false} footer={<>
    <Button disabled={change.busy} onClick={close}>取消</Button>
    <Button variant={deleting ? 'danger' : 'primary'} type="submit" form={form} loading={change.busy}>{deleting ? '确认删除' : '保存'}</Button>
  </>}>
    <form id={form} onSubmit={submit} autoComplete="off">
      <fieldset className="grid gap-4 text-sm" disabled={change.busy}>
        {deleting ? <p className="break-words">删除 <code className="break-all">{name}</code> 后，新连接将使用服务进程中的同名变量。若未设置，连接将失败。</p> : <>
          <label>变量名<Input required readOnly={action.type !== 'create'} pattern="[A-Z][A-Z0-9_]*" maxLength={128} spellCheck={false} placeholder="GITHUB_PAT_TOKEN" value={name} onChange={e => setName(e.target.value)} /></label>
          <label>新值<Input required type="password" autoComplete="new-password" spellCheck={false} maxLength={8192} value={value} onChange={e => setValue(e.target.value)} /></label>
          <p className="text-xs text-txt3">保存后不可查看原值。更改从下一次 MCP 连接起生效。</p>
        </>}
        {change.error && <p role="alert" className="text-err">{change.error}</p>}
      </fieldset>
    </form>
  </Modal>
}

export function PlatformEnvironment() {
  const variables = useResource(listVariables, [])
  const [action, setAction] = useState<Action | null>(null)
  return <div className="page-stack">
    <PageHeader title="环境变量" actions={<>
      <Button icon="refresh" loading={variables.loading} onClick={variables.reload}>刷新</Button>
      <Button icon="plus" variant="primary" onClick={() => setAction({ type: 'create' })}>新增变量</Button>
    </>} />
    <p className="text-sm text-txt3">此处仅列出平台保存的变量。MCP 服务按管理员授权的变量名引用凭据。</p>
    {variables.loading || variables.error || !variables.data.length
      ? <ResourceState loading={variables.loading} error={variables.error} onRetry={variables.reload} empty={!variables.data.length} title={variables.error ? undefined : '暂无平台变量'} />
      : <ul aria-label="平台环境变量" className="divide-y divide-line border-y border-line">
        {variables.data.map(name => <li key={name} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <code className="min-w-0 break-all text-sm">{name}</code>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setAction({ type: 'replace', name })}>替换值</Button>
            <Button variant="ghost" size="icon" icon="trash" title={`删除 ${name}`} aria-label={`删除 ${name}`} onClick={() => setAction({ type: 'delete', name })} />
          </div>
        </li>)}
      </ul>}
    {action && <VariableDialog action={action} close={() => setAction(null)} saved={() => {
      setAction(null); variables.reload(); notify(action.type === 'delete' ? '变量已删除' : '变量已保存')
    }} />}
  </div>
}
