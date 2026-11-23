import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useMatch, useNavigate, useParams, useSearchParams } from 'react-router'
import { canvasPath, command, deleteProject, getPlacement, projectPath, projectsPath, readWorkspace, renameProject, saveLayout, type Workspace } from '@/shared/api/work-projects'
import { ApiError } from '@/shared/http/client'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/modal'
import { ResourceState } from '@/shared/ui/resource-state'
import { Sheet, SheetContent, SheetTrigger } from '@/shared/ui/sheet'
import { ItemInspector } from './ItemInspector'
import { ProjectGraph } from './ProjectGraph'
import { ProjectOutline } from './ProjectOutline'
import { ProjectTodo } from './ProjectTodo'
import type { ProjectMutation } from './model'
import { rememberProject } from './preferences'

const viewLink = 'border-b-2 border-transparent px-1 py-2 text-sm text-txt2 hover:text-txt aria-[current=page]:border-accent aria-[current=page]:font-semibold aria-[current=page]:text-accent-2'
const dockQuery = '(min-width: 1360px)'
const wideOutline = () => window.matchMedia?.(dockQuery)?.matches ?? false
function subscribeOutlineWidth(change: () => void) {
  const media = window.matchMedia?.(dockQuery)
  media?.addEventListener('change', change)
  return () => media?.removeEventListener('change', change)
}

function OutlineDrawer({ children }: { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  return <Sheet open={open} onOpenChange={setOpen}>
    <SheetTrigger asChild><Button size="sm" variant="ghost" icon="panel-left">项目大纲</Button></SheetTrigger>
    <SheetContent side="left" title="项目大纲">{children(() => setOpen(false))}</SheetContent>
  </Sheet>
}

export function ProjectWorkspace() {
  const { projectId = '' } = useParams()
  return <WorkspaceScope key={projectId} projectId={projectId} />
}

function WorkspaceScope({ projectId }: { projectId: string }) {
  const resource = useResource(signal => readWorkspace(projectId, signal), null)
  const mutation = useMutation()
  const navigate = useNavigate()
  const location = useLocation()
  const routeKey = useRef(location.key)
  useEffect(() => { routeKey.current = location.key }, [location.key])
  const [params, setParams] = useSearchParams()
  const canvasId = useMatch('/work-projects/:projectId/canvases/:canvasId')?.params.canvasId ?? null
  const todo = !!useMatch('/work-projects/:projectId/todo')
  const base = projectPath(projectId)
  const workspace = resource.data
  const itemId = params.get('itemId')
  const focusItemId = params.get('focusItemId') ?? undefined
  const focusCardId = params.get('focusCardId') ?? undefined
  const missingCanvas = !!workspace && canvasId !== null && !workspace.canvases.some(canvas => canvas.id === canvasId)
  const savedTodo: unknown = location.state?.todoPath
  const todoPath = `${base}/todo`
  const returnTo = todo ? `${todoPath}${location.search || '?'}`
    : typeof savedTodo === 'string' && savedTodo.startsWith(`${todoPath}?`) ? savedTodo : todoPath
  const viewState = { todoPath: returnTo }
  const recentPath = canvasId && !missingCanvas ? canvasPath(projectId, canvasId) : todo ? `${base}/todo` : `${base}/map`
  const [settings, setSettings] = useState<'rename' | 'delete'>()
  const [locateNote, setLocateNote] = useState('')
  const docked = useSyncExternalStore(subscribeOutlineWidth, wideOutline, () => false)
  const [dockOpen, setDockOpen] = useState(true)
  const outlineId = useId()
  const loadedProjectId = workspace?.project.id

  useEffect(() => {
    if (loadedProjectId) rememberProject(loadedProjectId, recentPath)
  }, [loadedProjectId, recentPath])

  if (!workspace) return <div className="page-stack">
    <Link className="text-accent-2" to={projectsPath}>返回工作项目</Link>
    <ResourceState loading={resource.loading} error={resource.error} onRetry={resource.reload} />
  </div>

  const busy = resource.loading || !!resource.error || mutation.busy
  const run: ProjectMutation['run'] = (send, done) => {
    if (busy) return
    void mutation.run(async signal => {
      try { return await send(signal) } catch (cause) {
        if (cause instanceof ApiError && [404, 409].includes(cause.status) && !signal.aborted) resource.reload()
        throw cause
      }
    }, result => {
      resource.reload()
      done?.(result)
    })
  }
  const mutate: ProjectMutation = {
    run,
    command: (action, done) => run(signal => command(workspace.project, action, signal), result => done?.(result.id)),
    layout: (id, layout, done) => run(signal => saveLayout(projectId, id, layout, signal), done),
  }

  function openItem(id: string | null) {
    setLocateNote('')
    const next = new URLSearchParams(params)
    if (id) next.set('itemId', id)
    else next.delete('itemId')
    // Keep the TODO return location while opening the inspector from a focused canvas.
    setParams(next, { state: location.state })
  }

  function locate(id: string) {
    setLocateNote('')
    run(signal => getPlacement(id, signal), placement => {
      if (routeKey.current !== location.key) return
      if (placement?.projectId !== projectId) {
        setLocateNote('工作项已移出当前项目，请在完整详情中查看最新位置。')
        return
      }
      const next = new URLSearchParams({ focusItemId: id })
      navigate(`${canvasPath(projectId, placement.canvasId)}?${next}`, { state: viewState })
    })
  }

  const focus = workspace.items.find(({ item }) => item.id === focusItemId)
  const focusCanvas = workspace.taskCards.find(card => card.id === focus?.taskCardId)?.canvasId
  const outline = (onNavigate?: () => void) => <ProjectOutline workspace={workspace} canvasId={canvasId} cardId={focusCardId}
    itemId={itemId ?? focusItemId} navigationKey={location.key} todoPath={returnTo} onNavigate={onNavigate} />
  const inspector = itemId && <>
    {locateNote && <p role="status" className="mb-2 text-sm text-txt3">{locateNote}</p>}
    <ItemInspector workspace={workspace} itemId={itemId} busy={busy} mutate={mutate} onClose={() => openItem(null)} onLocate={placed => locate(placed.item.id)} />
  </>

  return <div className="page-stack min-w-0">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="min-w-0 break-words text-xl font-semibold">{workspace.project.name}</h1>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => setSettings('rename')}>重命名项目</Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => setSettings('delete')}>删除项目</Button>
      </div>
    </header>
    <div className="flex items-center justify-between gap-2 border-b border-line">
      <nav aria-label="项目视图" className="flex gap-4">
        <Link to={`${base}/map`} state={viewState} className={viewLink} aria-current={!todo && canvasId === null ? 'page' : undefined}>地图</Link>
        <Link to={returnTo} className={viewLink} aria-current={todo ? 'page' : undefined}>待办</Link>
      </nav>
      {docked ? <Button size="sm" variant="ghost" icon="panel-left" aria-controls={outlineId} aria-expanded={dockOpen}
        onClick={() => setDockOpen(open => !open)}>项目大纲</Button> : <OutlineDrawer>{outline}</OutlineDrawer>}
    </div>
    {resource.error && <ResourceState error={resource.error} onRetry={resource.reload} />}
    {mutation.error && <p role="alert" className="break-words text-sm text-err">{mutation.error}</p>}
    {settings && <ProjectSettings key={settings} mode={settings} workspace={workspace} disabled={busy}
      error={mutation.error} onClose={() => setSettings(undefined)}
      onRename={name => run(signal => renameProject(workspace.project, name, signal), () => setSettings(undefined))}
      onDelete={() => run(signal => deleteProject(projectId, signal), () => navigate(projectsPath, { replace: true }))} />}
    <div className="flex min-w-0 items-start gap-4">
      {docked && <aside id={outlineId} aria-label="项目大纲" hidden={!dockOpen}
        className="scroll-area max-h-[62dvh] w-48 shrink-0 overflow-y-auto overscroll-contain rounded-md border border-line bg-surface">
        {outline()}
      </aside>}
      <div className="min-w-0 flex-1 space-y-3">
        {focusItemId && canvasId && focusCanvas !== canvasId && <p role="status" className="text-sm text-txt3">
          此事项已不在当前画布。{' '}{focusCanvas
            ? <Link className="text-accent-2" state={viewState} to={`${canvasPath(projectId, focusCanvas)}?${new URLSearchParams(itemId === focusItemId ? { focusItemId, itemId } : { focusItemId })}`}>打开当前画布</Link>
            : <Link className="text-accent-2" to={`/work-items/${encodeURIComponent(focusItemId)}`}>查看工作项详情</Link>}
        </p>}
        {todo || missingCanvas ? <div className={`grid min-w-0 items-start gap-4 ${inspector ? 'lg:grid-cols-[minmax(0,1fr)_18rem]' : ''}`}>
          {missingCanvas ? <div className="space-y-2">
            <ResourceState empty title="画布不存在" />
            <Link className="text-accent-2" to={`${base}/map`} state={viewState}>返回地图</Link>
          </div> : <ProjectTodo workspace={workspace} onItem={openItem}
            onCreate={id => navigate(canvasPath(projectId, id), { state: viewState })} />}
          {inspector && <div className="order-first min-w-0 lg:order-last">{inspector}</div>}
        </div> : <ProjectGraph workspace={workspace} canvasId={canvasId} locatedItemId={focusItemId} locatedCardId={focusCardId} busy={busy} mutate={mutate}
          itemInspector={inspector} onItem={openItem} onCanvas={id => navigate(canvasPath(projectId, id), { state: viewState })} />}
      </div>
    </div>
  </div>
}

function ProjectSettings({ mode, workspace, disabled, error, onClose, onRename, onDelete }: {
  mode: 'rename' | 'delete'; workspace: Workspace; disabled: boolean; error: string
  onClose: () => void; onRename: (name: string) => void; onDelete: () => void
}) {
  const [name, setName] = useState(workspace.project.name)
  const rename = mode === 'rename'
  const occupied = workspace.items.length > 0
  function submit(event: FormEvent) {
    event.preventDefault()
    if (disabled) return
    if (rename && name.trim()) onRename(name.trim())
    if (!rename && !occupied) onDelete()
  }
  return <Modal open title={rename ? '重命名项目' : '删除项目'} onClose={onClose}>
    <form className="space-y-3" onSubmit={submit}>
      {rename ? <label className="text-sm">项目名称<Input required value={name} disabled={disabled} onChange={event => setName(event.target.value)} /></label>
        : <p className="break-words text-sm">{occupied ? `项目内仍有 ${workspace.items.length} 项 TODO，请先移出。` : `删除「${workspace.project.name}」及其画布、任务卡和关系？`}</p>}
      {error && <p role="alert" className="text-sm text-err">{error}</p>}
      <div className="flex gap-2"><Button onClick={onClose}>取消</Button>
        <Button type="submit" variant={rename ? 'primary' : 'danger'} disabled={disabled || (rename ? !name.trim() : occupied)}>{rename ? '保存项目名称' : '确认删除项目'}</Button></div>
    </form>
  </Modal>
}
