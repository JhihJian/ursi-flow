import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { categories, saveWorkItem, statuses, workItemPath, type Category, type WorkDraft, type WorkItem, type WorkStatus } from '@/shared/api/work-items'
import type { PlacedItem, Workspace } from '@/shared/api/work-projects'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/modal'
import { Select } from '@/shared/ui/select'
import { Textarea } from '@/shared/ui/textarea'

import type { ProjectMutation } from './model'

export function ItemInspector({ workspace, itemId, busy, mutate, embedded, note, onClose, onLocate }: {
  workspace: Workspace
  itemId: string
  busy: boolean
  mutate: ProjectMutation
  embedded: boolean
  note: string
  onClose: () => void
  onLocate: (item: PlacedItem) => void
}) {
  const placed = workspace.items.find(({ item }) => item.id === itemId)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const sideBySide = window.matchMedia('(min-width: 1024px)').matches
    heading.current?.focus({ preventScroll: embedded && sideBySide })
  }, [embedded, itemId])
  return <aside aria-label="工作项详情" className={embedded ? 'min-w-0' : 'min-w-0 overflow-hidden rounded-lg border border-line bg-surface'}>
    <header className="flex min-h-10 items-center justify-between gap-2 border-b border-line bg-elevated/40 px-3 py-1">
      <h2 ref={heading} tabIndex={-1} className="text-sm font-semibold">工作项详情</h2>
      <Button size="sm" variant="ghost" icon="close" className="w-7 px-0" aria-label="关闭详情" title="关闭详情" onClick={onClose} />
    </header>
    <div className="space-y-3 p-3">
      {note && <p role="status" className="text-sm text-txt3">{note}</p>}
      {placed ? <>
        <ContentEditor key={itemId} item={placed.item} busy={busy} mutate={mutate} />
        <PlacementEditor key={JSON.stringify([itemId, placed.taskCardId])} workspace={workspace} placed={placed} busy={busy} mutate={mutate} onLocate={onLocate} />
      </> : <p role="status" className="text-sm text-txt3">此工作项已不在当前项目中，无法在此项目画布中定位。</p>}
      <Button asChild size="sm"><Link to={workItemPath(itemId)}>查看完整详情</Link></Button>
    </div>
  </aside>
}

function ContentEditor({ item, busy, mutate }: { item: WorkItem; busy: boolean; mutate: ProjectMutation }) {
  // 未编辑字段始终取自最新快照。冲突重读时保留手动修改，待用户再次保存。
  const [edits, setEdits] = useState<Partial<WorkDraft>>({})
  const [validation, setValidation] = useState('')
  const fields = { ...item, ...edits }
  const changed = fields.title.trim() !== item.title || fields.description !== item.description || fields.category !== item.category || fields.status !== item.status

  function edit<K extends keyof WorkDraft>(key: K, value: WorkDraft[K]) {
    setEdits(previous => {
      const next = { ...previous, [key]: value }
      if (value === item[key]) delete next[key]
      return next
    })
    if (key === 'title') setValidation('')
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !changed) return
    if (!fields.title.trim()) return setValidation('请填写标题。')
    mutate.run(signal => saveWorkItem({ ...fields, title: fields.title.trim() }, item, signal), () => setEdits({}))
  }

  return <form onSubmit={submit}>
    <fieldset disabled={busy} className="grid min-w-0 gap-3 text-sm">
      <label>标题<Input required value={fields.title} onChange={event => edit('title', event.target.value)} /></label>
      <label>工作说明<Textarea rows={4} value={fields.description} onChange={event => edit('description', event.target.value)} /></label>
      <label>类别<Select value={fields.category} onChange={event => edit('category', event.target.value as Category)}>
        {Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select></label>
      <label>状态<Select value={fields.status} onChange={event => edit('status', event.target.value as WorkStatus)}>
        {Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select></label>
      {validation && <p role="alert" className="text-err">{validation}</p>}
      <div><Button size="sm" type="submit" variant="primary" disabled={!changed}>保存工作项</Button></div>
    </fieldset>
  </form>
}

function PlacementEditor({ workspace, placed, busy, mutate, onLocate }: {
  workspace: Workspace
  placed: PlacedItem
  busy: boolean
  mutate: ProjectMutation
  onLocate: (item: PlacedItem) => void
}) {
  const [targetId, setTargetId] = useState('')
  const [unplacing, setUnplacing] = useState(false)
  const card = workspace.taskCards.find(card => card.id === placed.taskCardId)
  const canvas = workspace.canvases.find(canvas => canvas.id === card?.canvasId)
  const destinations = workspace.canvases.map(canvas => ({
    canvas,
    cards: workspace.taskCards.filter(card => card.canvasId === canvas.id && card.id !== placed.taskCardId),
  })).filter(({ cards }) => cards.length > 0)
  const target = destinations.flatMap(({ cards }) => cards).find(card => card.id === targetId)

  return <section className="space-y-2 border-t border-line pt-3">
    <h3 className="text-sm font-semibold">归属位置</h3>
    <p className="break-all text-sm text-txt3">{card && canvas ? `${canvas.name} / ${card.name}` : '找不到当前任务卡'}</p>
    {card && canvas && <Button size="sm" onClick={() => onLocate(placed)}>在画布中定位</Button>}
    <fieldset disabled={busy} className="grid min-w-0 gap-2 text-sm">
      {destinations.length > 0 && <label>目标任务卡<Select value={target?.id ?? ''} onChange={event => setTargetId(event.target.value)}>
        <option value="">选择任务卡</option>
        {destinations.map(({ canvas, cards }) => <optgroup key={canvas.id} label={canvas.name}>
          {cards.map(card => <option key={card.id} value={card.id}>{card.name}</option>)}
        </optgroup>)}
      </Select></label>}
      <div className="flex flex-wrap gap-2">
        {destinations.length > 0 && <Button size="sm" disabled={!target} onClick={() => {
          if (target && !busy) mutate.command({ type: 'placeItem', workItemId: placed.item.id, taskCardId: target.id })
        }}>移动工作项</Button>}
        <Button size="sm" variant="danger" onClick={() => setUnplacing(true)}>移出项目</Button>
      </div>
    </fieldset>
    <Modal open={unplacing} title="移出项目" onClose={() => setUnplacing(false)} footer={<>
      <Button onClick={() => setUnplacing(false)}>取消</Button>
      <Button variant="danger" disabled={busy} onClick={() => {
        setUnplacing(false)
        mutate.command({ type: 'placeItem', workItemId: placed.item.id, taskCardId: null })
      }}>确认移出</Button>
    </>}>
      <p className="break-all">「{placed.item.title}」将从任务卡移出，仍保留在工作清单中。</p>
    </Modal>
  </section>
}
