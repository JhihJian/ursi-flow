import { useEffect, useRef } from 'react'
import { statuses } from '@/shared/api/work-items'
import type { PlacedItem } from '@/shared/api/work-projects'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { menuAnchor, type MenuAnchor } from '@/shared/ui/menu-anchor'
import type { Counts } from './graph-data'

export function GraphCanvasProgress({ counts }: { counts?: Counts }) {
  const total = counts?.total ?? 0
  const completed = counts?.completed ?? 0
  return <div className="min-w-0 space-y-1 text-xs text-txt3">
    <p>共 {total} 项 · 已完成 {completed} 项</p>
    <progress className="block h-1.5 w-full accent-accent" max={total || 1} value={completed} aria-label="TODO 完成进度" />
    <p>待开始 {counts?.pending ?? 0} · 进行中 {counts?.active ?? 0}</p>
  </div>
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
  function reorder(index: number, change: number) {
    if (busy) return
    const ids = rows.map(row => row.item.id)
    const target = index + change
    if (target < 0 || target >= ids.length) return
    const [id] = ids.splice(index, 1)
    ids.splice(target, 0, id)
    onReorder(ids)
  }
  return <ol ref={list} aria-label="卡内 TODO" className={cn('relative divide-y divide-line', graph && 'scroll-area max-h-40 overflow-y-auto overscroll-contain')}>
    {rows.map(({ item }, index) => {
      const highlighted = locatedItemId === item.id
      return <li key={item.id} ref={highlighted ? located : undefined} aria-current={highlighted || undefined}
        onContextMenu={onContext ? event => onContext(item.id, menuAnchor(event, event.currentTarget.querySelector('button'))) : undefined}
        className={cn('flex min-w-0 items-center gap-1 py-1', highlighted && 'bg-accent/15 ring-1 ring-inset ring-accent')}>
        <div className="min-w-0 flex-1 px-1">
          <button type="button" className="block max-w-full break-words text-left text-xs text-accent-2 hover:underline focus-visible:outline-accent"
            onClick={() => onItem(item.id)}>{item.title}</button>
          <span className="block text-[11px] text-txt3">{statuses[item.status]}</span>
        </div>
        <div className="flex shrink-0 items-center">
          <Button size="sm" variant="ghost" icon="arrow-up" className={graph ? 'w-6 px-0' : 'h-9 w-9 p-0'} title="上移" aria-label={`上移 ${item.title}`}
            disabled={busy || index === 0} onClick={() => reorder(index, -1)} />
          <Button size="sm" variant="ghost" icon="arrow-up" className={graph ? 'w-6 px-0 [&_svg]:rotate-180' : 'h-9 w-9 p-0 [&_svg]:rotate-180'} title="下移" aria-label={`下移 ${item.title}`}
            disabled={busy || index === rows.length - 1} onClick={() => reorder(index, 1)} />
          <Button size="sm" variant="ghost" className={graph ? 'px-1' : 'h-9'} aria-label={`移动 ${item.title}`} disabled={busy}
            onClick={() => onMoveItem(item.id)}>移动</Button>
        </div>
      </li>
    })}
  </ol>
}
