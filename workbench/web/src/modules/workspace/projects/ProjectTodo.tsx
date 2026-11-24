import { useId, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { categories, statuses, type Category, type WorkStatus } from '@/shared/api/work-items'
import type { Workspace } from '@/shared/api/work-projects'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { Select } from '@/shared/ui/select'

const statusOrder = ['pending', 'active', 'completed'] as const
const statusMark = { pending: 'bg-txt3', active: 'bg-accent', completed: 'bg-ok' }
type Filters = { canvasId?: string; taskCardId?: string; category?: Category | '' }
type TodoRow = { id: string; title: string; location: string }

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
  const cards = new Map(workspace.taskCards.map(card => [card.id, card]))
  const canvasParam = params.get('canvasId') || ''
  const cardParam = params.get('taskCardId') || ''
  const categoryParam = params.get('category') || ''
  const canvas = canvases.get(canvasParam)
  const candidateCard = cards.get(cardParam)
  const card = candidateCard && (!canvas || canvas.id === candidateCard.canvasId) ? candidateCard : undefined
  const category = Object.hasOwn(categories, categoryParam) ? categoryParam as Category : undefined
  const invalid = Boolean((canvasParam && !canvas) || (cardParam && !card) || (categoryParam && !category))
  const filters: Filters = { canvasId: canvas?.id, taskCardId: card?.id, category }
  const availableCards = workspace.taskCards.filter(card => !canvas || card.canvasId === canvas.id)
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
    const placementCard = cards.get(taskCardId)
    const placementCanvas = placementCard && canvases.get(placementCard.canvasId)
    if (!placementCard || !placementCanvas) continue
    if ((canvas && canvas.id !== placementCanvas.id) || (card && card.id !== taskCardId) || (category && item.category !== category)) continue
    const location = card ? '' : canvas ? placementCard.name : `${placementCanvas.name} / ${placementCard.name}`
    groups[item.status].push({ id: item.id, title: item.title, location })
  }
  const visibleStatuses = statusOrder.filter(status => groups[status].length > 0)
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
    <section id={filterId} hidden={!filterOpen} aria-label="待办筛选">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2 text-sm">
        <label className="min-w-0">画布<Select value={canvas?.id ?? ''} onChange={event => selectCanvas(event.target.value)}>
          <option value="">全部画布</option>
          {workspace.canvases.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
        </Select></label>
        <label className="min-w-0">任务卡<Select value={card?.id ?? ''} onChange={event => setFilters({ ...filters, taskCardId: event.target.value })}>
          <option value="">全部任务卡</option>
          {availableCards.map(option => <option key={option.id} value={option.id}>
            {canvas ? option.name : `${canvases.get(option.canvasId)?.name ?? '未知画布'} / ${option.name}`}
          </option>)}
        </Select></label>
        <label className="min-w-0">类别<Select value={category ?? ''} onChange={event => setFilters({ ...filters, category: event.target.value as Category | '' })}>
          <option value="">全部类别</option>
          {Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select></label>
      </div>
    </section>
    {invalid && <p role="status" className="text-sm text-txt3">部分筛选条件已失效，已按其余有效条件显示。</p>}
    {visibleStatuses.length ? <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] items-start gap-3">
      {visibleStatuses.map(status => <section key={status} aria-label={statuses[status]} className="min-w-0">
        <h3 className="flex items-center gap-2 rounded-md bg-elevated/60 px-3 py-2 text-sm font-semibold">
          <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', statusMark[status])} />
          {statuses[status]} <span className="ml-auto text-xs tabular-nums text-txt3">{groups[status].length}</span>
        </h3>
        <ul className="divide-y divide-line">
          {groups[status].map(row => <li key={row.id}>
            <button type="button" aria-current={row.id === itemId || undefined}
              className="group flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm text-txt2 hover:bg-elevated/60 hover:text-txt focus-visible:outline-accent aria-current:bg-accent-dim aria-current:text-accent-2"
              onClick={() => onItem(row.id)}>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="block font-medium">{row.title}</span>
                {row.location && <span className="mt-0.5 block text-xs font-normal text-txt3">{row.location}</span>}
              </span>
              <Icon name="chevron-right" size={14} className="shrink-0 text-txt3 group-hover:text-txt" />
            </button>
          </li>)}
        </ul>
      </section>)}
    </div> : <div className="flex flex-wrap items-center gap-3 px-3 py-3 text-sm text-txt3">
      <p role="status">{workspace.items.length ? '没有符合筛选条件的待办' : '暂无项目待办'}</p>
      {!workspace.items.length && createCanvas && <Button size="sm" icon="arrow-right" onClick={() => onCreate(createCanvas.id)}>转到画布建项</Button>}
    </div>}
  </section>
}
