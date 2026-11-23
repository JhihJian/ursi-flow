import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useMatch, useNavigate, useParams, useSearchParams } from 'react-router'
import { canvasPath, command, deleteProject, getPlacement, projectPath, projectsPath, renameProject, saveLayout, type Workspace } from '@/shared/api/work-projects'
import { ApiError } from '@/shared/http/client'
import { useMutation } from '@/shared/hooks/use-mutation'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Modal } from '@/shared/ui/modal'
import { ResourceState } from '@/shared/ui/resource-state'
import { ItemInspector } from './ItemInspector'
import { ProjectGraph } from './ProjectGraph'
import { ProjectTodo } from './ProjectTodo'
import type { ProjectMutation } from './model'
import { todoPath, useProjectNavigation } from './project-navigation'

export function ProjectWorkspace() {
  const { projectId = '' } = useParams()
  return <WorkspaceScope key={projectId} projectId={projectId} />
}

function WorkspaceScope({ projectId }: { projectId: string }) {
  const { workspace: resource, projects, remember } = useProjectNavigation()
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
  const returnTo = todoPath(projectId, location.state)
  const recentPath = canvasId && !missingCanvas ? canvasPath(projectId, canvasId) : todo ? `${base}/todo` : `${base}/map`
  const [settings, setSettings] = useState<'rename' | 'delete'>()
  const [locateNote, setLocateNote] = useState('')

  useEffect(() => {
    if (workspace) remember(projectId, recentPath)
  }, [workspace, projectId, recentPath, remember])

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
      navigate(`${canvasPath(projectId, placement.canvasId)}?${next}`, {
        state: { todoPath: todo ? `${location.pathname}${location.search || '?'}` : returnTo },
      })
    })
  }

  const focus = workspace.items.find(({ item }) => item.id === focusItemId)
  const focusCanvas = workspace.taskCards.find(card => card.id === focus?.taskCardId)?.canvasId
  const inspector = itemId && <>
    {locateNote && <p role="status" className="mb-2 text-sm text-txt3">{locateNote}</p>}
    <ItemInspector workspace={workspace} itemId={itemId} busy={busy} mutate={mutate} onClose={() => openItem(null)} onLocate={placed => locate(placed.item.id)} />
  </>

  return <div className="page-stack min-w-0">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
      <div className="min-w-0">
        <Link className="text-xs text-accent-2 hover:underline" to={projectsPath}>全部项目</Link>
        <h1 className="break-words text-xl font-semibold">{workspace.project.name}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => setSettings('rename')}>重命名项目</Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => setSettings('delete')}>删除项目</Button>
      </div>
    </header>
    {resource.error && <ResourceState error={resource.error} onRetry={resource.reload} />}
    {mutation.error && <p role="alert" className="break-words text-sm text-err">{mutation.error}</p>}
    {settings && <ProjectSettings key={settings} mode={settings} workspace={workspace} disabled={busy}
      error={mutation.error} onClose={() => setSettings(undefined)}
      onRename={name => run(signal => renameProject(workspace.project, name, signal), () => { projects.reload(); setSettings(undefined) })}
      onDelete={() => run(signal => deleteProject(projectId, signal), () => { projects.reload(); navigate(projectsPath, { replace: true }) })} />}
    {focusItemId && canvasId && focusCanvas !== canvasId && <p role="status" className="text-sm text-txt3">
      此事项已不在当前画布。{' '}{focusCanvas
        ? <Link className="text-accent-2" to={`${canvasPath(projectId, focusCanvas)}?${new URLSearchParams({ focusItemId })}`}>打开当前画布</Link>
        : <Link className="text-accent-2" to={`/work-items/${encodeURIComponent(focusItemId)}`}>查看工作项详情</Link>}
    </p>}
    {todo || missingCanvas ? <div className={`grid min-w-0 items-start gap-4 ${inspector ? 'lg:grid-cols-[minmax(0,1fr)_18rem]' : ''}`}>
      {missingCanvas ? <div className="space-y-2">
        <ResourceState empty title="画布不存在" />
        <Link className="text-accent-2" to={`${base}/map`}>返回 Canvas Map</Link>
      </div> : <ProjectTodo workspace={workspace} onItem={openItem}
        onCreate={id => navigate(canvasPath(projectId, id), { state: { todoPath: `${location.pathname}${location.search || '?'}` } })} />}
      {inspector && <div className="order-first min-w-0 lg:order-last">{inspector}</div>}
    </div> : <ProjectGraph workspace={workspace} canvasId={canvasId} locatedItemId={focusItemId} locatedCardId={focusCardId} busy={busy} mutate={mutate}
      itemInspector={inspector} onItem={openItem} onCanvas={id => navigate(canvasPath(projectId, id))} />}
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
