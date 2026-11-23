import type { Point } from '@/modules/canvas'
import type { WorkStatus } from '@/shared/api/work-items'
import type { Named, PlacedItem, Relation, Workspace } from '@/shared/api/work-projects'

export const emptyLayout = { revision: 0, positions: {} }
export type Counts = Record<WorkStatus, number> & { total: number }
const zeroCounts: Counts = { pending: 0, active: 0, completed: 0, total: 0 }

export function projectGraphData(workspace: Workspace) {
  const cardItems = new Map(workspace.taskCards.map(card => [card.id, [] as PlacedItem[]]))
  const cardCanvas = new Map(workspace.taskCards.map(card => [card.id, card.canvasId]))
  const canvasCounts = new Map(workspace.canvases.map(canvas => [canvas.id, { ...zeroCounts }]))
  for (const placed of workspace.items) {
    cardItems.get(placed.taskCardId)?.push(placed)
    const counts = canvasCounts.get(cardCanvas.get(placed.taskCardId) ?? '')
    if (counts) {
      counts.total++
      counts[placed.item.status]++
    }
  }
  for (const rows of cardItems.values()) rows.sort((a, b) => a.rank - b.rank)
  return { cardItems, canvasCounts }
}

export function reorderedItems(rows: readonly PlacedItem[], id: string, step: -1 | 1) {
  const index = rows.findIndex(row => row.item.id === id)
  const target = index + step
  if (index < 0 || target < 0 || target >= rows.length) return
  const ids = rows.map(row => row.item.id)
  ;[ids[index], ids[target]] = [ids[target], ids[index]]
  return ids
}

export function graphPositions(nodes: readonly Named[], saved: Record<string, Point>, map: boolean) {
  const occupied = nodes.flatMap(({ id }) => saved[id] ? [saved[id]] : [])
  const rowHeight = map ? 220 : 380
  let slot = 0
  return new Map(nodes.map(({ id }) => {
    if (saved[id]) return [id, saved[id]]
    let position: Point
    do {
      position = { x: (slot % 3) * 320, y: Math.floor(slot / 3) * rowHeight }
      slot++
    } while (occupied.some(point => Math.abs(point.x - position.x) < 280 && Math.abs(point.y - position.y) < rowHeight - 30))
    return [id, position]
  }))
}

export function relationProblem(nodes: readonly Named[], relations: readonly Relation[], from: string, to: string, relationId?: string) {
  if (!nodes.some(node => node.id === from) || !nodes.some(node => node.id === to)) return '请选择此图中的两个端点。'
  if (from === to) return '关系的前项和后项不能相同。'
  const next = new Map<string, string[]>()
  for (const relation of relations) {
    if (relation.id === relationId) continue
    if (relation.from === from && relation.to === to) return '这条关系已存在。'
    const targets = next.get(relation.from) ?? []
    targets.push(relation.to)
    next.set(relation.from, targets)
  }
  const seen = new Set<string>()
  const pending = [to]
  while (pending.length) {
    const node = pending.pop()!
    if (node === from) return '这条关系会形成循环。'
    if (seen.has(node)) continue
    seen.add(node)
    for (const target of next.get(node) ?? []) pending.push(target)
  }
  return ''
}
