import { useSearchParams } from 'react-router'
import { categories, statuses, type Category, type WorkStatus } from '@/shared/api/work-items'
import type { Named, PlacedItem, TaskCard, Workspace } from '@/shared/api/work-projects'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'

const statusOrder = ['pending', 'active', 'completed'] as const
const emptyCounts = () => ({ pending: 0, active: 0, completed: 0 })
type Filters = { canvasId?: string; taskCardId?: string; category?: Category | '' }
type TodoRow = { item: PlacedItem['item']; canvas: Named; card: TaskCard }

export function ProjectTodo({ workspace, onItem, onCreate }: {
  workspace: Workspace
  onItem: (itemId: string) => void
  onCreate: (canvasId: string) => void
}) {
  const [params, setParams] = useSearchParams()
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

  const projectCounts = emptyCounts()
  const canvasCounts = new Map(workspace.canvases.map(canvas => [canvas.id, emptyCounts()]))
  const groups: Record<WorkStatus, TodoRow[]> = { pending: [], active: [], completed: [] }
  let visibleCount = 0
  for (const placed of workspace.items) {
    const { item } = placed
    projectCounts[item.status]++
    const placementCard = cards.get(placed.taskCardId)
    const placementCanvas = placementCard && canvases.get(placementCard.canvasId)
    if (!placementCard || !placementCanvas) continue
    canvasCounts.get(placementCanvas.id)![item.status]++
    if ((canvas && canvas.id !== placementCanvas.id) || (card && card.id !== placementCard.id) || (category && item.category !== category)) continue
    groups[item.status].push({ item, canvas: placementCanvas, card: placementCard })
    visibleCount++
  }

  return <div className="min-w-0 space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-lg font-semibold">项目待办</h2>
      {createCanvas && <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="break-all text-sm text-txt3">{createCanvas.name}</span>
        <Button variant="primary" onClick={() => onCreate(createCanvas.id)}>转到画布建项</Button>
      </div>}
    </header>
    <section className="space-y-2" aria-label="项目状态分布">
      <h3 className="font-semibold">全项目状态 · {workspace.items.length} 项</h3>
      <dl className="grid grid-cols-3 divide-x divide-line border-y border-line">
        {statusOrder.map(status => <div key={status} className="px-2 py-2 sm:px-3">
          <dt className="text-xs text-txt3">{statuses[status]}</dt>
          <dd className="text-lg font-semibold tabular-nums">{projectCounts[status]}</dd>
        </div>)}
      </dl>
    </section>
    {workspace.canvases.length > 0 && <section className="space-y-2" aria-label="画布摘要">
      <h3 className="font-semibold">画布摘要</h3>
      <ul className="grid gap-2 sm:grid-cols-2">
        {workspace.canvases.map(summary => {
          const counts = canvasCounts.get(summary.id)!
          const selected = canvas?.id === summary.id
          return <li key={summary.id} className="min-w-0">
            <Button block variant={selected ? 'secondary' : 'default'} className="h-auto min-h-12 justify-start whitespace-normal px-3 py-2 text-left aria-pressed:border aria-pressed:border-accent"
              aria-pressed={selected} onClick={() => selectCanvas(selected ? '' : summary.id)}>
              <span className="min-w-0 space-y-1">
                <span className="block break-all">{summary.name}</span>
                <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-txt3">
                  {statusOrder.map(status => <span key={status}>{statuses[status]} {counts[status]}</span>)}
                </span>
              </span>
            </Button>
          </li>
        })}
      </ul>
    </section>}
    <section className="space-y-2 border-t border-line pt-3" aria-label="待办筛选">
      <div className="grid gap-2 text-sm sm:grid-cols-3">
        <label className="min-w-0">画布<Select value={canvas?.id ?? ''} onChange={e => selectCanvas(e.target.value)}>
          <option value="">全部画布</option>
          {workspace.canvases.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
        </Select></label>
        <label className="min-w-0">任务卡<Select value={card?.id ?? ''} onChange={e => setFilters({ ...filters, taskCardId: e.target.value })}>
          <option value="">全部任务卡</option>
          {availableCards.map(option => <option key={option.id} value={option.id}>
            {canvas ? option.name : `${canvases.get(option.canvasId)?.name ?? '未知画布'} / ${option.name}`}
          </option>)}
        </Select></label>
        <label className="min-w-0">类别<Select value={category ?? ''} onChange={e => setFilters({ ...filters, category: e.target.value as Category | '' })}>
          <option value="">全部类别</option>
          {Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select></label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-txt3">
        <p>显示 {visibleCount} / {workspace.items.length} 项</p>
        {(canvas || card || category || invalid) && <Button size="sm" variant="ghost" onClick={() => setFilters({})}>清除筛选</Button>}
      </div>
      {invalid && <p role="status" className="text-sm text-txt3">部分筛选条件已失效，已按其余有效条件显示。</p>}
    </section>
    {!visibleCount ? <ResourceState empty title={workspace.items.length ? '没有符合筛选条件的工作项' : '暂无项目工作项'}
      description={workspace.items.length ? '可清除或调整筛选条件。' : '此项目的画布上暂无归属的工作项。'} /> :
      statusOrder.map(status => <section key={status} className="border-t border-line pt-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">{statuses[status]} <Badge variant="secondary">{groups[status].length}</Badge></h3>
        {groups[status].length ? <ul className="divide-y divide-line">
          {groups[status].map(({ item, canvas, card }) => <li key={item.id}>
            <Button variant="ghost" block className="h-auto min-h-10 justify-start whitespace-normal px-2 py-2 text-left" onClick={() => onItem(item.id)}>
              <span className="min-w-0">
                <span className="block break-all font-medium text-accent-2">{item.title}</span>
                <span className="block break-all text-xs text-txt3">{canvas.name} / {card.name} · {categories[item.category]}</span>
              </span>
            </Button>
          </li>)}
        </ul> : <p className="py-2 text-sm text-txt3">暂无工作项</p>}
      </section>)}
  </div>
}
