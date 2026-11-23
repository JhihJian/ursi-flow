import { Link, useMatch, useSearchParams } from 'react-router'
import { canvasPath, projectPath, projectsPath, readWorkspace, type Workspace } from '@/shared/api/work-projects'
import { statuses } from '@/shared/api/work-items'
import { useResource } from '@/shared/hooks/use-resource'
import { cn } from '@/shared/lib/utils'
import { Icon } from '@/shared/ui/icon'
import { useProjectNavigation } from './project-navigation'

const row = 'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs text-txt2 hover:bg-overlay/50 hover:text-txt focus-visible:outline-accent'
const selected = 'bg-accent-dim font-semibold text-accent-2'
const tool = 'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-txt3 hover:bg-overlay/50 hover:text-txt focus-visible:outline-accent'
const branch = 'ml-3 space-y-0.5 border-l border-line pl-1.5'

function TreeToggle({ id, name, defaultOpen }: { id: string; name: string; defaultOpen: boolean }) {
  const { isOpen, setOpen } = useProjectNavigation()
  const open = isOpen(id, defaultOpen)
  const label = `${open ? '折叠' : '展开'} ${name}`
  return <button type="button" className={tool} aria-label={label} aria-expanded={open} title={label} onClick={() => setOpen(id, !open)}>
    <Icon name="chevron-right" size={14} className={cn('motion-safe:transition-transform', open && 'rotate-90')} />
  </button>
}

export function ProjectTree({ onNavigate }: { onNavigate?: () => void }) {
  const state = useProjectNavigation()
  const { projects, workspace, projectId, isOpen, preferences, togglePinned, refreshWorkspaces } = state
  const pinned = new Set(preferences.pinned)
  const rows = [...projects.data].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)))
  return <nav aria-label="项目树" className="flex min-h-24 flex-1 flex-col border-t border-line px-2.5 pb-2">
    <div className="flex shrink-0 items-center justify-between gap-1 px-1 pt-2">
      <h2 className="text-xs font-semibold text-txt3">项目树</h2>
      <div className="flex gap-0.5">
        <button className={tool} type="button" aria-label="刷新项目树" title="刷新项目树" onClick={() => { projects.reload(); refreshWorkspaces() }}>
          <Icon name="refresh" size={15} />
        </button>
        <Link to={projectsPath} className={tool} aria-label="管理或新建项目" title="管理或新建项目" onClick={onNavigate}><Icon name="plus" size={16} /></Link>
      </div>
    </div>
    <div className="scroll-area min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      {projects.error && <p role="status" className="break-words px-1 py-1 text-xs text-err">{projects.error}</p>}
      {!rows.length && !projects.error && <p className="px-1 py-1 text-xs text-txt3">{projects.loading ? '正在读取项目…' : '暂无项目'}</p>}
      <ul className="space-y-0.5">{rows.map(project => {
        const active = project.id === projectId
        const key = `project:${project.id}`
        const open = isOpen(key, active)
        const isPinned = pinned.has(project.id)
        return <li key={project.id}>
          <div className="flex min-w-0 items-center gap-0.5">
            <TreeToggle id={key} name={`项目 ${project.name}`} defaultOpen={active} />
            <Link to={`${projectPath(project.id)}/map`} onClick={onNavigate} className={cn(row, active && selected)}
              aria-current={active ? 'true' : undefined} title={project.name}>
              <Icon name="folder" size={15} /><span className="truncate">{project.name}</span>
            </Link>
            <button type="button" className={cn(tool, isPinned && 'text-accent-2')} title={isPinned ? '取消置顶' : '置顶'}
              aria-label={`置顶 ${project.name}`} aria-pressed={isPinned} onClick={() => togglePinned(project.id)}><Icon name="pin" size={13} /></button>
          </div>
          {open && (active ? <ProjectBranch workspace={workspace.data} loading={workspace.loading} error={workspace.error} onRetry={workspace.reload} onNavigate={onNavigate} />
            : <OtherProjectBranch projectId={project.id} onNavigate={onNavigate} />)}
        </li>
      })}</ul>
    </div>
  </nav>
}

function OtherProjectBranch({ projectId, onNavigate }: { projectId: string; onNavigate?: () => void }) {
  const { treeRevision } = useProjectNavigation()
  const resource = useResource(signal => readWorkspace(projectId, signal), null, String(treeRevision))
  return <ProjectBranch workspace={resource.data} loading={resource.loading} error={resource.error} onRetry={resource.reload} onNavigate={onNavigate} />
}

function ProjectBranch({ workspace, loading, error, onRetry, onNavigate }: {
  workspace: Workspace | null; loading: boolean; error: string; onRetry: () => void; onNavigate?: () => void
}) {
  const { isOpen, projectId } = useProjectNavigation()
  const [params] = useSearchParams()
  const canvasRoute = useMatch('/work-projects/:projectId/canvases/:canvasId')?.params
  if (error) return <button type="button" className="ml-8 text-left text-xs text-err" onClick={onRetry}>画布加载失败，重试</button>
  if (!workspace) return <p className="ml-8 text-xs text-txt3">{loading ? '正在读取画布…' : '暂无画布'}</p>

  const id = workspace.project.id
  const active = id === projectId
  const itemId = active ? params.get('itemId') ?? params.get('focusItemId') : null
  const focusedCardId = active ? workspace.items.find(placed => placed.item.id === itemId)?.taskCardId ?? params.get('focusCardId') : null
  const focusedCanvasId = workspace.taskCards.find(card => card.id === focusedCardId)?.canvasId
  const selectedCanvasId = canvasRoute?.projectId === id ? canvasRoute.canvasId : null
  const itemsByCard = new Map<string, typeof workspace.items>()
  for (const placed of workspace.items) {
    const items = itemsByCard.get(placed.taskCardId) ?? []
    items.push(placed)
    itemsByCard.set(placed.taskCardId, items)
  }
  return <ul className={branch}>{workspace.canvases.map(canvas => {
    const key = `canvas:${canvas.id}`
    const cards = workspace.taskCards.filter(card => card.canvasId === canvas.id)
    const current = canvas.id === selectedCanvasId
    const defaultOpen = active && (current || canvas.id === focusedCanvasId || workspace.canvases.length === 1)
    const path = canvasPath(id, canvas.id)
    return <li key={canvas.id}>
      <div className="flex min-w-0 items-center gap-0.5">
        <Link to={path} onClick={onNavigate} aria-current={current ? 'true' : undefined} className={cn(row, current && selected)} aria-label={canvas.name} title={`${canvas.name} · ${cards.length} 张任务卡`}>
          <Icon name="workflow" size={14} /><span className="min-w-0 flex-1 truncate">{canvas.name}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-txt3" aria-hidden="true">{cards.length}</span>
        </Link>
        <TreeToggle id={key} name={`画布 ${canvas.name}`} defaultOpen={defaultOpen} />
      </div>
      {isOpen(key, defaultOpen) && <ul className={branch}>
        {!cards.length && <li className="py-1 text-xs text-txt3">暂无任务卡</li>}
        {cards.map(card => {
          const cardKey = `card:${card.id}`
          const focused = focusedCardId === card.id
          const items = itemsByCard.get(card.id) ?? []
          return <li key={card.id}>
            <div className="flex min-w-0 items-center gap-0.5">
              <Link to={`${path}?${new URLSearchParams({ focusCardId: card.id })}`} onClick={onNavigate}
                aria-current={focused && !itemId ? 'true' : undefined} className={cn(row, focused && selected)} aria-label={card.name} title={`${card.name} · ${items.length} 项 TODO`}>
                <Icon name="layers" size={14} /><span className="min-w-0 flex-1 truncate">{card.name}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-txt3" aria-hidden="true">{items.length}</span>
              </Link>
              <TreeToggle id={cardKey} name={`任务卡 ${card.name}`} defaultOpen={focused} />
            </div>
            {isOpen(cardKey, focused) && <ul className={branch}>
              {!items.length && <li className="py-1 text-xs text-txt3">暂无 TODO</li>}
              {items.sort((a, b) => a.rank - b.rank).map(({ item }) => <li key={item.id}>
                <Link to={`${path}?${new URLSearchParams({ focusItemId: item.id, itemId: item.id })}`} onClick={onNavigate}
                  aria-current={itemId === item.id ? 'page' : undefined} className={cn(row, itemId === item.id && selected)} title={`${item.title} · ${statuses[item.status]}`}>
                  <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', item.status === 'completed' ? 'bg-ok' : item.status === 'active' ? 'bg-accent' : 'border border-txt3')} />
                  <span className="min-w-0 truncate">{item.title}</span>
                  <span className="sr-only">{statuses[item.status]}</span>
                </Link>
              </li>)}
            </ul>}
          </li>
        })}
      </ul>}
    </li>
  })}</ul>
}
