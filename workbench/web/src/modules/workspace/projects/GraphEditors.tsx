import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { categories, listWorkItems, type Category, type WorkDraft } from '@/shared/api/work-items'
import { getPlacement, type Named, type Relation, type Workspace } from '@/shared/api/work-projects'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/modal'
import { Select } from '@/shared/ui/select'
import { Textarea } from '@/shared/ui/textarea'

export function GraphEditor({ title, saving, error, onCancel, children }: {
  title: string; saving: boolean; error: string; onCancel: () => void; children: ReactNode
}) {
  return <Modal open title={<span className="line-clamp-2 break-all" title={title}>{title}</span>} onClose={onCancel}
    closeOnBackdrop={false} closeOnEsc={!saving} closeDisabled={saving} bodyClassName="space-y-3">
    {children}
    {error && <p role="alert" className="break-words text-sm text-err">{error}</p>}
  </Modal>
}

type FormProps = { busy: boolean; saving: boolean; onCancel: () => void }

function GraphForm({ busy, saving, onCancel, onSubmit, children, submitLabel = '保存', disabled = false, destructive = false }: FormProps & {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void; children: ReactNode; submitLabel?: string; disabled?: boolean; destructive?: boolean
}) {
  return <form onSubmit={event => {
    event.preventDefault()
    if (!busy && !disabled) onSubmit(event)
  }}>
    <fieldset disabled={busy} className="grid min-w-0 gap-3 text-sm">{children}</fieldset>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button type="submit" variant={destructive ? 'destructive' : 'primary'} disabled={busy || disabled}>{submitLabel}</Button>
      <Button disabled={saving} onClick={onCancel}>取消</Button>
    </div>
  </form>
}

export function GraphNameForm({ label, current = '', onSave, ...form }: FormProps & {
  label: string; current?: string; onSave: (name: string) => void
}) {
  const [name, setName] = useState(current)
  const [error, setError] = useState('')
  return <GraphForm {...form} disabled={Boolean(current) && name.trim() === current} onSubmit={() => {
    const trimmed = name.trim()
    if (!trimmed) return setError('请填写名称。')
    onSave(trimmed)
  }}>
    <label>{label}<Input required value={name} onChange={event => { setName(event.target.value); setError('') }} /></label>
    {error && <p role="alert" className="text-err">{error}</p>}
  </GraphForm>
}

export function GraphTodoForm({ onSave, ...form }: FormProps & { onSave: (draft: Omit<WorkDraft, 'status'>) => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<Category>('one_time')
  const [error, setError] = useState('')
  return <GraphForm {...form} submitLabel="创建 TODO" onSubmit={() => {
    if (!title.trim()) return setError('请填写标题。')
    onSave({ title: title.trim(), description, category })
  }}>
    <label>标题<Input required value={title} onChange={event => { setTitle(event.target.value); setError('') }} /></label>
    <label>工作说明<Textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label>
    <label>类别<Select value={category} onChange={event => setCategory(event.target.value as Category)}>
      {Object.entries(categories).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
    </Select></label>
    {error && <p role="alert" className="text-err">{error}</p>}
  </GraphForm>
}

export function GraphAddForm({ workspace, onSave, busy, saving, onCancel }: FormProps & {
  workspace: Workspace; onSave: (workItemId: string) => void
}) {
  // The global list has no placement data. Exclude known placements, then verify on submit.
  const items = useResource(listWorkItems, [])
  const verify = useMutation()
  const [selected, setSelected] = useState('')
  const [unavailable, setUnavailable] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const placed = new Set(workspace.items.map(row => row.item.id))
  const options = items.data.filter(item => !placed.has(item.id) && !unavailable.includes(item.id))
  const eligible = options.some(item => item.id === selected)
  const latest = useRef({ busy, placed })
  useEffect(() => { latest.current = { busy, placed } })
  return <GraphForm busy={busy || verify.busy} saving={saving} onCancel={onCancel} submitLabel="加入任务卡" disabled={!eligible || items.loading || Boolean(items.error)} onSubmit={() => {
    setMessage('')
    void verify.run(signal => getPlacement(selected, signal), placement => {
      if (placement !== null || latest.current.placed.has(selected)) {
        setUnavailable(previous => [...previous, selected])
        setSelected('')
        setMessage('该事项已归属任务卡。请先从原项目移出，或在原任务卡中使用「移动」。')
      } else if (latest.current.busy) {
        setMessage('工作区正在保存，请稍后重试。')
      } else {
        onSave(selected)
      }
    })
  }}>
    {items.loading && <p role="status" className="text-txt3">正在读取全局事项…</p>}
    {items.error && <div role="alert" className="flex flex-wrap items-center gap-2 text-err">
      <span>{items.error}</span><Button size="sm" onClick={items.reload}>重新加载</Button>
    </div>}
    {!items.loading && !items.error && (options.length ? <label>已有事项<Select required value={eligible ? selected : ''} onChange={event => {
      setSelected(event.target.value)
      setMessage('')
    }}>
      <option value="">请选择事项</option>
      {options.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}
    </Select></label> : <p className="text-txt3">没有可加入的事项。</p>)}
    {verify.busy && <p role="status" className="text-txt3">正在核对事项归属…</p>}
    {message && <p role="alert" className="text-err">{message}</p>}
    {verify.error && <p role="alert" className="text-err">{verify.error}</p>}
  </GraphForm>
}

export function GraphMoveForm({ workspace, cardId, onSave, ...form }: FormProps & {
  workspace: Workspace; cardId: string; onSave: (cardId: string | null) => void
}) {
  const [target, setTarget] = useState('')
  const [remove, setRemove] = useState(false)
  const groups = workspace.canvases.map(canvas => ({ ...canvas, cards: workspace.taskCards.filter(card => card.canvasId === canvas.id && card.id !== cardId) }))
    .filter(canvas => canvas.cards.length)
  const eligible = groups.some(canvas => canvas.cards.some(card => card.id === target))
  return <GraphForm {...form} disabled={!remove && !eligible} submitLabel={remove ? '确认移出' : '确认移动'} destructive={remove}
    onSubmit={() => onSave(remove ? null : target)}>
    {groups.length ? <label>目标任务卡<Select disabled={remove} required={!remove} value={eligible ? target : ''} onChange={event => setTarget(event.target.value)}>
      <option value="">请选择目标任务卡</option>
      {groups.map(canvas => <optgroup key={canvas.id} label={canvas.name}>
        {canvas.cards.map(card => <option key={card.id} value={card.id}>{card.name}</option>)}
      </optgroup>)}
    </Select></label> : <p className="text-txt3">项目中没有其他任务卡。</p>}
    <label className="flex items-center gap-2"><input type="checkbox" checked={remove} onChange={event => setRemove(event.target.checked)} />移出项目，保留在全局清单</label>
  </GraphForm>
}

export function GraphRelationForm({ nodes, relation, onSave, ...form }: FormProps & {
  nodes: readonly Named[]; relation?: Relation; onSave: (from: string, to: string) => void
}) {
  const [from, setFrom] = useState(relation?.from ?? '')
  const [to, setTo] = useState(relation?.to ?? '')
  const unchanged = relation?.from === from && relation?.to === to
  const options = nodes.map(node => <option value={node.id} key={node.id}>{node.name}</option>)
  return <GraphForm {...form} disabled={!from || !to || unchanged} onSubmit={() => onSave(from, to)}>
    <label>前项<Select required value={from} onChange={event => setFrom(event.target.value)}>
      <option value="">请选择前项</option>{options}
    </Select></label>
    <label>后项<Select required value={to} onChange={event => setTo(event.target.value)}>
      <option value="">请选择后项</option>{options}
    </Select></label>
  </GraphForm>
}

export function GraphDeleteForm({ children, onDelete, ...form }: FormProps & { children: ReactNode; onDelete: () => void }) {
  return <GraphForm {...form} submitLabel="确认删除" destructive onSubmit={onDelete}><p className="break-words text-txt2">{children}</p></GraphForm>
}
