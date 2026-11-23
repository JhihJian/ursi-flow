import { useEffect, useRef } from 'react'
import { statuses } from '@/shared/api/work-items'
import type { PlacedItem } from '@/shared/api/work-projects'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { menuAnchor, type MenuAnchor } from '@/shared/ui/menu-anchor'
import { reorderedItems, type Counts } from './graph-data'

export function GraphCanvasSummary({ counts }: { counts?: Counts }) {
  return <p className="text-xs text-txt3">待开始 {counts?.pending ?? 0} · 进行中 {counts?.active ?? 0} · 已完成 {counts?.completed ?? 0}</p>
}

export function GraphCardItems({ rows, locatedItemId, graph, busy, onItem, onReorder, onMoveItem, onContext }: {
  rows: readonly PlacedItem[]; locatedItemId?: string; graph: boolean; busy: boolean
  onItem: (id: string) => void; onReorder: (ids: string[]) => void; onMoveItem: (id: string) => void
  onContext?: (id: string, anchor: MenuAnchor) => void
}) {
  const located = useRef<HTMLLIElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const locatedIndex = rows.findIndex(row => row.item.id === locatedItemId)
  useEffect(() => {
    const row = located.current
    const container = list.current
    if (!locatedItemId || !row || !container) return
    if (!graph) {
      row.scrollIntoView?.({ block: 'nearest' })
      return
    }
    // Use unscaled offsets so graph zoom does not affect scrolling within the card.
    container.scrollTop = Math.max(0, row.offsetTop - (container.clientHeight - row.offsetHeight) / 2)
  }, [graph, locatedItemId, locatedIndex, rows.length])

  if (!rows.length) return <p className="text-xs text-txt3">暂无 TODO</p>
  function reorder(id: string, step: -1 | 1) {
    const ids = reorderedItems(rows, id, step)
    if (ids && !busy) onReorder(ids)
  }
  return <ol ref={list} aria-label="卡内 TODO" className={cn('relative', graph ? 'scroll-area grid max-h-32 gap-1 overflow-y-auto overscroll-contain' : 'divide-y divide-line')}>
    {rows.map(({ item }, index) => {
      const highlighted = locatedItemId === item.id
      return <li key={item.id} ref={highlighted ? located : undefined} aria-current={highlighted || undefined}
        onContextMenu={onContext ? event => onContext(item.id, menuAnchor(event, event.currentTarget.querySelector('button'))) : undefined}
        className={cn('flex min-w-0 items-center gap-1', graph ? 'rounded border border-line bg-base px-1.5' : 'py-1',
          highlighted && 'bg-accent/15 ring-1 ring-inset ring-accent')}>
        <div className={cn('min-w-0 flex-1', graph && 'flex items-center justify-between gap-1.5')}>
          <button type="button" title={item.title} className={cn('block min-w-0 text-left text-xs text-accent-2 hover:underline focus-visible:outline-accent',
            graph ? 'truncate py-1' : 'max-w-full break-words')} onClick={() => onItem(item.id)}>{item.title}</button>
          <span className="block shrink-0 text-[11px] text-txt3">{statuses[item.status]}</span>
        </div>
        {graph ? onContext && <Button size="sm" className="h-6 w-6 shrink-0 p-0" variant="ghost" icon="more"
          aria-label={`${item.title}的操作`} title="TODO 操作" aria-haspopup="menu"
          onClick={event => onContext(item.id, menuAnchor(event, event.currentTarget))} />
          : <div className="flex shrink-0 items-center">
            <Button size="sm" variant="ghost" icon="arrow-up" className="h-9 w-9 p-0" title="上移" aria-label={`上移 ${item.title}`}
              disabled={busy || index === 0} onClick={() => reorder(item.id, -1)} />
            <Button size="sm" variant="ghost" icon="arrow-up" className="h-9 w-9 p-0 [&_svg]:rotate-180" title="下移" aria-label={`下移 ${item.title}`}
              disabled={busy || index === rows.length - 1} onClick={() => reorder(item.id, 1)} />
            <Button size="sm" variant="ghost" className="h-9" aria-label={`移动 ${item.title}`} disabled={busy}
              onClick={() => onMoveItem(item.id)}>移动</Button>
          </div>}
      </li>
    })}
  </ol>
}
