import { useId, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { categories, statuses, type Category, type WorkStatus } from '@/shared/api/work-items'
import type { Workspace } from '@/shared/api/work-projects'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { Select } from '@/shared/ui/select'

const statusOrder = ['pending', 'active', 'completed'] as const
type TodoRow = { id: string; title: string; location: string }
type Filters = { canvasId?: string; taskCardId?: string; category?: Category | '' }

/** 各状态的视觉基调：圆点、渐变条与图标沿用同一配色。 */
const statusTone: Record<WorkStatus, { dot: string; bar: string; segment: string; icon: string }> = {
  pending: { dot: 'bg-txt3/70', bar: 'from-txt3/70 to-txt3/25', segment: 'bg-txt3/60', icon: 'clock' },
  active: { dot: 'bg-info', bar: 'from-info/85 to-accent/70', segment: 'bg-info', icon: 'play' },
  completed: { dot: 'bg-ok', bar: 'from-ok/80 to-ok/40', segment: 'bg-ok', icon: 'check' },
}

export function ProjectTodo({ workspace, itemId, onItem, onCreate }: {
  workspace: Workspace
  itemId: string | null
  onItem: (itemId: string) => void
  onCreate: (canvasId: string) => void
}) {
  const [params, setParams] = useSearchParams()
  const [filterOpen, setFilterOpen] = useState(false)
  const filterId = useId()
  const filterToggle = useRef<HTMLButtonElement>(null)
  const canvases = new Map(workspace.canvases.map(canvas => [canvas.id, canvas]))
  const cardById = new Map(workspace.taskCards.map(card => [card.id, card]))
  const canvasParam = params.get('canvasId') || ''
  const cardParam = params.get('taskCardId') || ''
  const categoryParam = params.get('category') || ''
  const canvas = canvases.get(canvasParam)
  const candidateCard = cardById.get(cardParam)
  const card = candidateCard && (!canvas || canvas.id === candidateCard.canvasId) ? candidateCard : undefined
  const category = Object.hasOwn(categories, categoryParam) ? categoryParam as Category : undefined
  const invalid = Boolean((canvasParam && !canvas) || (cardParam && !card) || (categoryParam && !category))
  const filters: Filters = { canvasId: canvas?.id, taskCardId: card?.id, category }
  const availableCards = workspace.taskCards.filter(option => !canvas || option.canvasId === canvas.id)
  const createCanvas = canvas ?? (card && canvases.get(card.canvasId)) ?? workspace.canvases[0]

  function setFilters(filters: Filters) {
    const next = new URLSearchParams(params)
    for (const key of ['canvasId', 'taskCardId', 'category'] as const) {
      const value = filters[key]
      if (value) next.set(key, value)
      else next.delete(key)
    }
    setParams(next)
  }

  function selectCanvas(canvasId: string) {
    setFilters({ ...filters, canvasId, taskCardId: !canvasId || card?.canvasId === canvasId ? card?.id : undefined })
  }

  const groups: Record<WorkStatus, TodoRow[]> = { pending: [], active: [], completed: [] }
  for (const { item, taskCardId } of workspace.items) {
    const placementCard = cardById.get(taskCardId)
    const placementCanvas = placementCard && canvases.get(placementCard.canvasId)
    if (!placementCard || !placementCanvas) continue
    if ((canvas && canvas.id !== placementCanvas.id) || (card && card.id !== taskCardId) || (category && item.category !== category)) continue
    const location = card ? '' : canvas ? placementCard.name : `${placementCanvas.name} / ${placementCard.name}`
    groups[item.status].push({ id: item.id, title: item.title, location })
  }
  const visibleStatuses = statusOrder.filter(status => groups[status].length > 0)
  const counts: Record<WorkStatus, number> = { pending: groups.pending.length, active: groups.active.length, completed: groups.completed.length }
  const total = statusOrder.reduce((sum, status) => sum + counts[status], 0)
  const scope = [canvas?.name ?? (card && canvases.get(card.canvasId)?.name), card?.name].filter(Boolean).join(' / ')
  const summary = [scope, category && categories[category]].filter(Boolean).join(' · ')

  return <section className="min-w-0 space-y-3" aria-label="项目待办">
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line pb-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">项目待办</h2>
        {!filterOpen && summary && <p className="min-w-0 text-xs text-txt3 [overflow-wrap:anywhere]">{summary}</p>}
      </div>
      <div className="flex items-center gap-1">
        {(summary || invalid) && <Button size="sm" className="h-9" variant="ghost" onClick={() => {
          setFilters({})
          filterToggle.current?.focus()
        }}>清除筛选</Button>}
        <Button ref={filterToggle} size="sm" className="h-9" variant={filterOpen || summary ? 'secondary' : 'ghost'} icon="filter" aria-expanded={filterOpen}
          aria-controls={filterId} onClick={() => setFilterOpen(open => !open)}>筛选</Button>
      </div>
    </header>
    <section id={filterId} hidden={!filterOpen} aria-label="待办筛选" className="panel p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="field min-w-0"><span className="field-label">画布</span>
          <Select value={canvas?.id ?? ''} onChange={event => selectCanvas(event.target.value)}>
            <option value="">全部画布</option>
            {workspace.canvases.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
          </Select>
        </label>
        <label className="field min-w-0"><span className="field-label">任务卡</span>
          <Select value={card?.id ?? ''} onChange={event => setFilters({ ...filters, taskCardId: event.target.value })}>
            <option value="">全部任务卡</option>
            {availableCards.map(option => <option key={option.id} value={option.id}>
              {canvas ? option.name : `${canvases.get(option.canvasId)?.name ?? '未知画布'} / ${option.name}`}
            </option>)}
          </Select>
        </label>
        <label className="field min-w-0"><span className="field-label">类别</span>
          <Select value={category ?? ''} onChange={event => setFilters({ ...filters, category: event.target.value as Category | '' })}>
            <option value="">全部类别</option>
            {Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </label>
      </div>
    </section>
    {invalid && <p role="status" className="text-sm text-txt3">部分筛选条件已失效，已按其余有效条件显示。</p>}
    {workspace.items.length > 0 && <div className="panel animate-in fade-in slide-in-from-bottom-2 flex flex-col gap-4 p-4 duration-500 sm:flex-row sm:items-center sm:gap-6">
      <div className="flex items-end gap-2">
        <span className="text-4xl font-semibold leading-none tracking-tight tabular-nums">{total}</span>
        <span className="pb-0.5 text-xs text-txt3">项待办</span>
      </div>
      <div className="min-w-0 flex-1 space-y-2.5">
        <div role="presentation" className="flex h-2 overflow-hidden rounded-full bg-elevated">
          {total > 0 && statusOrder.map(status => counts[status] > 0 && <div key={status}
            className={cn('h-full transition-[width] duration-500', statusTone[status].segment)}
            style={{ width: `${(counts[status] / total) * 100}%` }} />)}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-txt3">
          {statusOrder.map(status => <span key={status} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn('size-1.5 rounded-full', statusTone[status].dot)} />
            {statuses[status]}
            <span className="font-medium tabular-nums text-txt2">{counts[status]}</span>
          </span>)}
        </div>
      </div>
    </div>}
    {visibleStatuses.length ? <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] items-start gap-3">
      {visibleStatuses.map(status => <TodoGroup key={status} status={status} rows={groups[status]} selectedId={itemId} onSelect={onItem} />)}
    </div> : <div className="panel flex flex-col items-center gap-3 px-5 py-10 text-center">
      <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-elevated text-txt3">
        <Icon name={workspace.items.length ? 'filter' : 'check'} size={18} />
      </span>
      <p role="status" className="text-sm text-txt3">{workspace.items.length ? '没有符合筛选条件的待办' : '暂无项目待办'}</p>
      {!workspace.items.length && createCanvas && <Button size="sm" icon="arrow-right" onClick={() => onCreate(createCanvas.id)}>转到画布建项</Button>}
    </div>}
  </section>
}

/** 状态分组卡片：左侧渐变条 + 图标标题 + 计数，条目以行卡形式堆叠。 */
function TodoGroup({ status, rows, selectedId, onSelect }: {
  status: WorkStatus
  rows: TodoRow[]
  selectedId: string | null
  onSelect: (itemId: string) => void
}) {
  const tone = statusTone[status]
  return <section aria-label={statuses[status]} className="panel animate-in fade-in slide-in-from-bottom-2 relative overflow-hidden duration-500">
    <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-1 bg-gradient-to-b', tone.bar)} />
    <header className="flex items-center gap-2 border-b border-line py-2.5 pl-4 pr-3">
      <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-elevated text-txt2">
        <Icon name={tone.icon} size={14} />
      </span>
      <h3 className="flex min-w-0 flex-1 items-center text-sm font-semibold">
        {statuses[status]} <span className="ml-auto rounded-md bg-elevated px-1.5 py-0.5 text-xs font-medium tabular-nums text-txt2">{rows.length}</span>
      </h3>
    </header>
    <ul className="space-y-1.5 p-2 pl-3.5">
      {rows.map(row => <li key={row.id}>
        <button type="button" aria-current={row.id === selectedId || undefined}
          className="group flex w-full flex-col gap-1 rounded-lg border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-elevated focus-visible:outline-accent aria-current:border-accent/60 aria-current:bg-accent-dim/70"
          onClick={() => onSelect(row.id)}>
          <span className="flex items-center justify-between gap-2">
            <span className="min-w-0 text-sm font-medium text-txt [overflow-wrap:anywhere]">{row.title}</span>
            <Icon name="chevron-right" size={14} className="shrink-0 text-txt3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          </span>
          {row.location && <span className="flex items-center gap-1 text-xs text-txt3">
            <Icon name="layers" size={12} className="shrink-0" />{row.location}
          </span>}
        </button>
      </li>)}
    </ul>
  </section>
}
