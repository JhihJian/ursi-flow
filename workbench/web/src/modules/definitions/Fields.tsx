import { cloneElement, useId, type ReactElement, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { history, resourceKindNames, type Latest, type Ref } from './catalog'
import { blankRef } from './draft'

function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId()
  return <div className="field"><label className="field-label" htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>
}
export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-6 text-txt3">{children}</p>
}
export function TextField({ label, value, change, multiline, required, readOnly }: {
  label: string; value: string; change: (v: string) => void; multiline?: boolean; required?: boolean; readOnly?: boolean
}) {
  return <Field label={label}>{multiline
    ? <textarea className="textarea" value={value} required={required} onChange={e => change(e.target.value)} />
    : <input className="input" value={value} readOnly={readOnly} required={required} onChange={e => change(e.target.value)} />}</Field>
}
export function Choice<T extends string>({ label, value, change, options, required }: {
  label: string; value: T; change: (v: T) => void; options: readonly (readonly [T, string])[]; required?: boolean
}) {
  return <Field label={label}><select className="select" value={value} required={required} onChange={e => change(e.target.value as T)}>
    {options.map(([v, name]) => <option key={v} value={v}>{name}</option>)}
  </select></Field>
}
function RevisionChoice({ value, change }: { value: Ref; change: (v: Ref) => void }) {
  const result = useResource(signal => history('resources', value.id, signal), [])
  const hasMcp = result.data.some(v => 'kind' in v && v.kind === 'mcp')
  return <div className="min-w-0"><Field label="资源版本"><select className="select" required value={value.revision || ''} onChange={e => change({ ...value, revision: Number(e.target.value) })}>
    <option value="">{result.loading ? '读取版本中…' : '选择固定版本'}</option>
    {result.data.map(v => <option key={v.revision} value={v.revision} disabled={'kind' in v && v.kind === 'mcp'}>v{v.revision}{'kind' in v ? ` · ${resourceKindNames[v.kind]}` : ''}</option>)}
  </select></Field>{result.error && <p role="alert">{result.error} <Button onClick={result.reload}>重试</Button></p>}
    {hasMcp && <p className="mt-1 text-xs text-txt3">MCP 引用版本不可选为执行依赖。</p>}</div>
}
function ResourcePicker({ choices, value, change }: { choices: Latest[]; value: Ref; change: (v: Ref) => void }) {
  return <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
    <Field label="资源 ID"><select className="select" required value={value.id} onChange={e => change({ id: e.target.value, revision: 0 })}>
      <option value="">选择资源</option>
      {choices.filter(v => v.active || v.id === value.id).map(v => <option key={v.id} value={v.id} disabled={!v.active}>{v.id}{!v.active ? '（已停用）' : ''}</option>)}
    </select></Field>
    {value.id ? <RevisionChoice key={value.id} value={value} change={change} /> : !choices.some(v => v.active) && <Link className="self-end text-accent-2" to="/resources/new">新建资源</Link>}
  </div>
}
export function ResourceRefs({ label, choices, value, change }: { label: string; choices: Latest[]; value: Ref[]; change: (v: Ref[]) => void }) {
  return <fieldset className="min-w-0 space-y-2"><legend className="font-medium">{label}</legend>{value.map((r, i) => <div key={i} className="flex flex-wrap items-end gap-2">
    <ResourcePicker choices={choices} value={r} change={v => change(value.map((p, n) => n === i ? v : p))} />
    <Button onClick={() => change(value.filter((_, n) => n !== i))}>移除资源</Button>
  </div>)}<Button onClick={() => change([...value, blankRef()])}>添加{label}</Button></fieldset>
}
