import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { statuses } from '@/shared/api/work-items'
import { canvasPath, type Workspace } from '@/shared/api/work-projects'
import { cn } from '@/shared/lib/utils'
import { Icon } from '@/shared/ui/icon'
import { projectGraphData } from './graph-data'

const row = 'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-2 text-sm text-txt2 hover:bg-overlay/50 hover:text-txt focus-visible:outline-accent aria-current:bg-accent-dim aria-current:text-accent-2'
const branch = 'ml-3 space-y-0.5 border-l border-line pl-2'

function Branch({ name, defaultOpen, revealKey, link, children }: {
  name: string; defaultOpen: boolean; revealKey?: string; link: ReactNode; children: ReactNode
}) {
  const [state, setState] = useState({ revealKey, open: defaultOpen })
  if (state.revealKey !== revealKey) setState({ revealKey, open: revealKey !== undefined || state.open })
  const open = state.open
  const label = `${open ? '折叠' : '展开'} ${name}`
  return <li>
    <div className="flex min-w-0 items-center gap-1">
      <button type="button" className="icon-button size-8 shrink-0" aria-label={label} aria-expanded={open} title={label} onClick={() => setState({ revealKey, open: !open })}>
        <Icon name="chevron-right" size={14} className={cn('motion-safe:transition-transform', open && 'rotate-90')} />
      </button>
      {link}
    </div>
    {open && <ul className={branch}>{children}</ul>}
  </li>
}

export function ProjectOutline({ workspace, canvasId, cardId, itemId, navigationKey, todoPath, onNavigate }: {
  workspace: Workspace; canvasId: string | null; cardId?: string | null; itemId?: string | null
  navigationKey: string; todoPath: string; onNavigate?: () => void
}) {
  const { cardItems } = projectGraphData(workspace)
  const focusedCard = workspace.items.find(placed => placed.item.id === itemId)?.taskCardId ?? cardId
  const state = { todoPath }
  return <nav aria-label="项目大纲" className="p-3">
    <ul className="space-y-1">{workspace.canvases.map(canvas => {
      const cards = workspace.taskCards.filter(card => card.canvasId === canvas.id)
      const current = canvas.id === canvasId
      const path = canvasPath(workspace.project.id, canvas.id)
      const reveal = current || cards.some(card => card.id === focusedCard)
      return <Branch key={canvas.id} name={`画布 ${canvas.name}`}
        defaultOpen={reveal || workspace.canvases.length === 1} revealKey={reveal ? navigationKey : undefined}
        link={<Link to={path} state={state} onClick={onNavigate} className={row} aria-current={current ? 'true' : undefined}>
          <Icon name="workflow" size={15} className="shrink-0" /><span className="min-w-0 break-words">{canvas.name}</span>
        </Link>}>
        {!cards.length && <li className="px-2 py-1 text-xs text-txt3">暂无任务卡</li>}
        {cards.map(card => {
          const items = cardItems.get(card.id) ?? []
          const focused = card.id === focusedCard
          return <Branch key={card.id} name={`任务卡 ${card.name}`} defaultOpen={focused} revealKey={focused ? navigationKey : undefined}
            link={<Link to={`${path}?${new URLSearchParams({ focusCardId: card.id })}`} state={state} onClick={onNavigate}
              aria-current={focused && !itemId ? 'true' : undefined} className={row}>
              <Icon name="layers" size={15} className="shrink-0" /><span className="min-w-0 break-words">{card.name}</span>
            </Link>}>
            {!items.length && <li className="px-2 py-1 text-xs text-txt3">暂无 TODO</li>}
            {items.map(({ item }) => <li key={item.id}>
              <Link to={`${path}?${new URLSearchParams({ focusItemId: item.id, itemId: item.id })}`} state={state} onClick={onNavigate}
                aria-current={itemId === item.id ? 'page' : undefined} className={row}>
                <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', item.status === 'completed' ? 'bg-ok' : item.status === 'active' ? 'bg-accent' : 'border border-txt3')} />
                <span className="min-w-0 break-words">{item.title}</span><span className="sr-only">{statuses[item.status]}</span>
              </Link>
            </li>)}
          </Branch>
        })}
      </Branch>
    })}</ul>
  </nav>
}
