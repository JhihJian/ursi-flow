import { cloneElement, useId, type ReactElement } from 'react'
import { Link } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { history, kindNames, titles, type Latest, type Ref } from './catalog'
import { blankRef, type FieldRow } from './draft'

function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId()
  return <div className="field"><label className="field-label" htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>
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
export function PortsEditor({ label, value, change, override }: {
  label: string; value?: FieldRow[]; change: (v?: FieldRow[]) => void; override?: boolean
}) {
  const rows = value ?? []
  const update = (i: number, patch: Partial<FieldRow>) => change(rows.map((v, n) => n === i ? { ...v, ...patch } : v))
  return <fieldset className="min-w-0 space-y-2"><legend className="font-medium">{label}声明</legend>
    {override && <label className="flex items-center gap-2"><input type="checkbox" checked={value !== undefined} onChange={e => change(e.target.checked ? [] : undefined)} />单独声明{label}（覆盖工作包）</label>}
    {(!override || value) && <>{rows.map((p, i) => <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
      <TextField label={`${label}字段名`} required value={p.name} change={name => update(i, { name })} />
      <Choice label={`${label}类型`} value={p.type} change={type => update(i, { type })} options={['string', 'number', 'integer', 'boolean', 'object', 'array'].map(t => [t, t])} />
      <Button onClick={() => change(rows.filter((_, n) => n !== i))}>移除{label}字段</Button>
    </div>)}<Button onClick={() => change([...rows, { name: '', type: 'string' }])}>添加{label}字段</Button></>}
  </fieldset>
}
type RefKind = 'resources' | 'executors'
function RevisionChoice({ k, value, change }: { k: RefKind; value: Ref; change: (v: Ref) => void }) {
  const result = useResource(signal => history(k, value.id, signal), [])
  const name = titles[k]
  return <div className="min-w-0"><Field label={`${name}版本`}><select className="select" required value={value.revision || ''} onChange={e => change({ ...value, revision: Number(e.target.value) })}>
    <option value="">{result.loading ? '读取版本中…' : '选择固定版本'}</option>
    {result.data.map(v => <option key={v.revision} value={v.revision} disabled={'kind' in v && v.kind === 'mcp'}>v{v.revision}{'kind' in v ? ` · ${kindNames[v.kind]}` : ''}</option>)}
  </select></Field>{result.error && <p role="alert">{result.error} <Button onClick={result.reload}>重试</Button></p>}</div>
}
export function RefPicker({ k, choices, value, change }: { k: RefKind; choices: Latest[]; value: Ref; change: (v: Ref) => void }) {
  const name = titles[k]
  return <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
    <Field label={`${name} ID`}><select className="select" required value={value.id} onChange={e => change({ id: e.target.value, revision: 0 })}>
      <option value="">选择{name}</option>
      {choices.filter(v => v.active || v.id === value.id).map(v => <option key={v.id} value={v.id} disabled={!v.active}>{v.id}{!v.active ? '（已停用）' : ''}</option>)}
    </select></Field>
    {value.id ? <RevisionChoice key={value.id} k={k} value={value} change={change} /> : !choices.some(v => v.active) && <Link className="self-end text-accent-2" to={`/${k}/new`}>新建{name}</Link>}
  </div>
}
export function ResourceRefs({ label, choices, value, change }: { label: string; choices: Latest[]; value: Ref[]; change: (v: Ref[]) => void }) {
  return <fieldset className="min-w-0 space-y-2"><legend className="font-medium">{label}</legend>{value.map((r, i) => <div key={i} className="flex flex-wrap items-end gap-2">
    <RefPicker k="resources" choices={choices} value={r} change={v => change(value.map((p, n) => n === i ? v : p))} />
    <Button onClick={() => change(value.filter((_, n) => n !== i))}>移除资源</Button>
  </div>)}<Button onClick={() => change([...value, blankRef()])}>添加{label}</Button></fieldset>
}
