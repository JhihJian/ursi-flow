import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link } from 'react-router'
import { CanvasGraph, type CanvasContextTarget, type CanvasNode, type CanvasSelection, type Point } from '@/modules/canvas'
import { ContextMenu, type ContextAction } from '@/shared/ui/context-menu'
import type { MenuAnchor } from '@/shared/ui/menu-anchor'
import { projectPath, type Command, type Named, type Relation, type Workspace } from '@/shared/api/work-projects'
import { Button } from '@/shared/ui/button'
import { ResourceState } from '@/shared/ui/resource-state'
import { GraphCanvasSummary, GraphCardItems } from './GraphCardItems'
import { GraphInspector, RelationNeighbors } from './GraphInspector'
import { GraphAddForm, GraphDeleteForm, GraphEditor, GraphMoveForm, GraphNameForm, GraphRelationForm, GraphTodoForm } from './GraphEditors'
import { emptyLayout, graphPositions, projectGraphData, relationProblem, reorderedItems } from './graph-data'
import type { ProjectMutation } from './model'

export type ProjectGraphProps = {
  workspace: Workspace
  canvasId: string | null
  locatedItemId?: string
  locatedCardId?: string
  busy: boolean
  mutate: ProjectMutation
  itemInspector?: ReactNode
  onItem: (id: string | null) => void
  onCanvas: (id: string) => void
}

type Selection = CanvasSelection | { kind: 'relations' | 'settings' } | null
type MenuTarget = CanvasContextTarget | { kind: 'todo'; id: string; cardId: string }
type Editor =
  | { kind: 'create' | 'createRelation' }
  | { kind: 'rename' | 'delete' | 'createItem' | 'addItem' | 'editRelation' | 'deleteRelation'; id: string }
  | { kind: 'moveItem'; id: string; sourceCardId: string }

const compactQuery = '(max-width: 767px)'
function subscribeViewport(change: () => void) {
  const media = window.matchMedia?.(compactQuery)
  if (media?.addEventListener) {
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }
  window.addEventListener('resize', change)
  return () => window.removeEventListener('resize', change)
}
function compactViewport() { return window.matchMedia?.(compactQuery)?.matches ?? window.innerWidth < 768 }

export function ProjectGraph(props: ProjectGraphProps) {
  return <GraphScope key={JSON.stringify([props.workspace.project.id, props.canvasId])} {...props} />
}

function GraphScope({ workspace, canvasId, locatedItemId, locatedCardId, busy, mutate, itemInspector, onItem, onCanvas }: ProjectGraphProps) {
  const map = canvasId === null
  const canvas = workspace.canvases.find(node => node.id === canvasId)
  const noun = map ? '画布' : '任务卡'
  const nodes = map ? workspace.canvases : workspace.taskCards.filter(card => card.canvasId === canvasId)
  const relations = workspace.relations.filter(relation => relation.canvasId === canvasId)
  const layout = map ? workspace.layouts.map : workspace.layouts.canvases[canvasId] ?? emptyLayout
  const { cardItems, canvasCounts } = useMemo(() => projectGraphData(workspace), [workspace])
  const located = !map && locatedItemId ? workspace.items.find(row => row.item.id === locatedItemId) : undefined
  const targetCardId = !map ? located?.taskCardId ?? locatedCardId : undefined
  const focusNodeId = nodes.find(node => node.id === targetCardId)?.id

  const focusKey = locatedItemId ?? locatedCardId
  const [chosen, setChosen] = useState<{ focusKey?: string; value: Selection }>()
  const [editor, setEditor] = useState<Editor>()
  const [menu, setMenu] = useState<{ target: MenuTarget; anchor: MenuAnchor }>()
  const [graphError, setGraphError] = useState('')
  const [listMode, setListMode] = useState(false)
  const [lastReset, setLastReset] = useState(0)
  const compact = useSyncExternalStore(subscribeViewport, compactViewport, () => false)
  const list = compact || listMode
  const positions = graphPositions(nodes, layout.positions, map)

  const defaultNodeId = map ? nodes[0]?.id : focusNodeId
  const selection = chosen && chosen.focusKey === focusKey ? chosen.value
    : defaultNodeId ? { kind: 'node' as const, id: defaultNodeId } : null
  const selectedNode = selection?.kind === 'node' ? nodes.find(node => node.id === selection.id) : undefined
  const selectedRelation = selection?.kind === 'edge' ? relations.find(relation => relation.id === selection.id) : undefined
  const graphSelection = selectedNode ? { kind: 'node' as const, id: selectedNode.id }
    : selectedRelation ? { kind: 'edge' as const, id: selectedRelation.id } : null
  const names = new Map(nodes.map(node => [node.id, node.name]))
  const nameOf = (id: string) => names.get(id) ?? id
  const relationLabel = (relation: Relation) => `${nameOf(relation.from)} → ${nameOf(relation.to)}`
  const reset = { disabled: busy || !Object.keys(layout.positions).length, run: () => savePositions({}, true) }

  function setSelection(value: Selection) { setChosen({ focusKey, value }) }

  function showSelection(value: Selection) {
    if (itemInspector) onItem(null)
    setSelection(value)
  }

  function openEditor(next?: Editor) {
    setGraphError('')
    setEditor(next)
  }

  function submit(action: Command, done?: (id?: string) => void) {
    if (busy) return
    setGraphError('')
    mutate.command(action, done)
  }

  function save(action: Command, done?: (id?: string) => void) {
    submit(action, id => {
      setEditor(current => current === editor ? undefined : current)
      done?.(id)
    })
  }

  function savePositions(next: Record<string, Point>, reset = false) {
    if (busy) return
    setGraphError('')
    mutate.layout(canvasId, { revision: layout.revision, positions: next }, () => {
      if (reset) setLastReset(layout.revision + 1)
    })
  }

  function saveRelation(from: string, to: string, existing?: Relation, inForm = false) {
    if (busy) return
    const problem = relationProblem(nodes, relations, from, to, existing?.id)
    if (problem) return setGraphError(problem)
    const action: Command = existing
      ? { type: 'replaceRelation', relationId: existing.id, from, to }
      : { type: 'createRelation', canvasId, from, to }
    const run = inForm ? save : submit
    run(action, id => {
      const relationId = existing?.id ?? id
      if (relationId) setSelection({ kind: 'edge', id: relationId })
    })
  }

  function deletionBlock(node: Named, isCanvas: boolean) {
    if (isCanvas) {
      if (canvasCounts.get(node.id)?.total) return '请先移走或移出画布内的 TODO。'
      if (workspace.canvases.length <= 1) return '项目至少保留一张画布。'
    } else if (cardItems.get(node.id)?.length) return '请先移走或移出任务卡内的 TODO。'
    return ''
  }

  function contextActions(target: MenuTarget): { label: string; actions: ContextAction[] } | undefined {
    if (target.kind === 'pane') return { label: '画布空白处操作', actions: [
      { label: `新建${noun}`, icon: 'plus', disabled: busy, run: () => openEditor({ kind: 'create' }) },
      { label: '新建关系', icon: 'workflow', disabled: busy || nodes.length < 2, run: () => openEditor({ kind: 'createRelation' }) },
      { label: '重置布局', icon: 'refresh', ...reset },
    ] }
    if (target.kind === 'edge') {
      const edge = relations.find(edge => edge.id === target.id)
      if (!edge) return
      return { label: `关系操作：${relationLabel(edge)}`, actions: [
        { label: '编辑关系', icon: 'edit', disabled: busy, run: () => openEditor({ kind: 'editRelation', id: edge.id }) },
        { label: '删除关系', icon: 'trash', danger: true, disabled: busy, run: () => openEditor({ kind: 'deleteRelation', id: edge.id }) },
      ] }
    }
    if (target.kind === 'todo') {
      const rows = cardItems.get(target.cardId) ?? []
      const item = names.has(target.cardId) && rows.find(row => row.item.id === target.id)?.item
      if (!item) return
      const above = reorderedItems(rows, item.id, -1)
      const below = reorderedItems(rows, item.id, 1)
      const reorder = (itemIds: string[]) => submit({ type: 'reorderItems', taskCardId: target.cardId, itemIds })
      return { label: `TODO 操作：${item.title}`, actions: [
        { label: '打开详情', icon: 'doc', run: () => onItem(item.id) },
        { label: '上移', icon: 'arrow-up', disabled: busy || !above, run: () => { if (above) reorder(above) } },
        { label: '下移', icon: 'chevron-down', disabled: busy || !below, run: () => { if (below) reorder(below) } },
        { label: '移动或移出 TODO', icon: 'arrow-right', disabled: busy,
          run: () => openEditor({ kind: 'moveItem', id: item.id, sourceCardId: target.cardId }) },
      ] }
    }
    const node = nodes.find(node => node.id === target.id)
    if (!node) return
    const blocked = deletionBlock(node, map)
    return { label: `${noun}操作：${node.name}`, actions: [
      ...(map ? [{ label: '打开画布', icon: 'folder', run: () => onCanvas(node.id) }] : [
        { label: '新建 TODO', icon: 'plus', disabled: busy, run: () => openEditor({ kind: 'createItem', id: node.id }) },
        { label: '加入已有事项', icon: 'layers', disabled: busy, run: () => openEditor({ kind: 'addItem', id: node.id }) },
      ]),
      { label: `重命名${noun}`, icon: 'edit', disabled: busy, run: () => openEditor({ kind: 'rename', id: node.id }) },
      { label: `删除${noun}`, icon: 'trash', danger: true, disabled: busy || Boolean(blocked), hint: blocked || undefined,
        run: () => openEditor({ kind: 'delete', id: node.id }) },
    ] }
  }

  function nodeActions(node: Named, isCanvas: boolean) {
    const label = isCanvas ? '画布' : '任务卡'
    const blocked = deletionBlock(node, isCanvas)
    return <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => openEditor({ kind: 'rename', id: node.id })}>重命名{label}</Button>
        <Button size="sm" variant="destructive" disabled={busy || Boolean(blocked)} onClick={() => openEditor({ kind: 'delete', id: node.id })}>删除{label}</Button>
      </div>
      {blocked && <p className="text-xs text-txt3">{blocked}</p>}
    </div>
  }

  function taskActions(node: Named) {
    return <div className="flex flex-wrap gap-1.5">
      <Button size="sm" icon="plus" disabled={busy} onClick={() => openEditor({ kind: 'createItem', id: node.id })}>新建 TODO</Button>
      <Button size="sm" disabled={busy} onClick={() => openEditor({ kind: 'addItem', id: node.id })}>加入已有事项</Button>
    </div>
  }

  function nodeContent(node: Named) {
    if (map) return <div className="flex flex-wrap items-center justify-between gap-1.5">
      <GraphCanvasSummary counts={canvasCounts.get(node.id)} />
      <Button size="sm" variant={list ? 'default' : 'ghost'} icon="arrow-right" title="打开画布" aria-label="打开画布"
        className={list ? undefined : 'w-6 px-0'} onClick={() => onCanvas(node.id)}>{list ? '打开画布' : undefined}</Button>
    </div>
    return <GraphCardItems graph={!list} rows={cardItems.get(node.id) ?? []} locatedItemId={focusNodeId === node.id ? locatedItemId : undefined}
      busy={busy} onItem={onItem}
      onReorder={itemIds => submit({ type: 'reorderItems', taskCardId: node.id, itemIds })}
      onMoveItem={id => openEditor({ kind: 'moveItem', id, sourceCardId: node.id })}
      onContext={list ? undefined : (id, anchor) => setMenu({ target: { kind: 'todo', id, cardId: node.id }, anchor })} />
  }

  function renderInspector() {
    if (itemInspector) return itemInspector
    const shell = { map, reset: map && !list ? reset : undefined }
    const onClose = () => setSelection(null)
    if (selection?.kind === 'relations') return <GraphInspector {...shell} title={map ? '画布关系' : '任务卡关系'} icon="workflow" onClose={onClose}>
      {relations.length ? <ul className="divide-y divide-line">
        {relations.map(relation => <li key={relation.id}>
          <button type="button" className="w-full break-words py-2 text-left text-sm text-txt2 hover:text-accent-2"
            onClick={() => setSelection({ kind: 'edge', id: relation.id })}>{relationLabel(relation)}</button>
        </li>)}
      </ul> : <p className="text-xs text-txt3">暂无关系</p>}
    </GraphInspector>
    if (selectedRelation) return <GraphInspector {...shell} title={map ? '画布关系' : '任务卡关系'} icon="workflow" onClose={onClose}>
      <dl className="space-y-2 break-words text-sm text-txt2">
        <div><dt className="text-xs text-txt3">前项</dt><dd>{nameOf(selectedRelation.from)}</dd></div>
        <div><dt className="text-xs text-txt3">后项</dt><dd>{nameOf(selectedRelation.to)}</dd></div>
      </dl>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" disabled={busy} onClick={() => openEditor({ kind: 'editRelation', id: selectedRelation.id })}>编辑关系</Button>
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => openEditor({ kind: 'deleteRelation', id: selectedRelation.id })}>删除关系</Button>
      </div>
    </GraphInspector>
    if (selection?.kind === 'settings' && canvas) return <GraphInspector {...shell} title="画布设置" icon="settings" onClose={onClose}>
      {nodeActions(canvas, true)}
    </GraphInspector>
    if (selectedNode && !list) return <GraphInspector {...shell} title={selectedNode.name} icon={map ? 'workflow' : 'layers'} onClose={onClose}>
      {map ? <>
        <GraphCanvasSummary counts={canvasCounts.get(selectedNode.id)} />
        <Button size="sm" icon="arrow-right" onClick={() => onCanvas(selectedNode.id)}>进入画布</Button>
      </> : <>
        <p className="text-xs text-txt3">{cardItems.get(selectedNode.id)?.length ?? 0} 项 TODO</p>
        {taskActions(selectedNode)}
      </>}
      <div className="space-y-2 border-t border-line pt-3">
        <RelationNeighbors title={map ? '前序画布' : '前序任务卡'} names={relations.filter(edge => edge.to === selectedNode.id).map(edge => nameOf(edge.from))} />
        <RelationNeighbors title={map ? '后续画布' : '后续任务卡'} names={relations.filter(edge => edge.from === selectedNode.id).map(edge => nameOf(edge.to))} />
      </div>
      <div className="border-t border-line pt-3">{nodeActions(selectedNode, map)}</div>
    </GraphInspector>
    if (map && !list) return <GraphInspector {...shell} title="Canvas Map" icon="workflow">
      <p className="text-sm text-txt3">未选中画布或关系</p>
    </GraphInspector>
  }

  function renderEditor(): ReactNode {
    if (!editor) return null
    const form = { busy, onCancel: () => openEditor() }
    const relation = 'id' in editor ? relations.find(edge => edge.id === editor.id) : undefined
    const node = 'id' in editor ? nodes.find(candidate => candidate.id === editor.id) : undefined
    switch (editor.kind) {
      case 'create':
        return <GraphEditor key="create" title={`新建${noun}`}>
          <GraphNameForm {...form} label={`${noun}名称`} onSave={name => {
            save(canvasId === null ? { type: 'createCanvas', name } : { type: 'createTaskCard', canvasId, name }, id => {
              if (id) setSelection({ kind: 'node', id })
            })
          }} />
        </GraphEditor>
      case 'rename':
      case 'delete': {
        const isCanvas = map || editor.id === canvasId
        const target = isCanvas ? workspace.canvases.find(candidate => candidate.id === editor.id) : node
        if (!target) break
        const label = isCanvas ? '画布' : '任务卡'
        const blocked = deletionBlock(target, isCanvas)
        return <GraphEditor key={`${editor.kind}:${target.id}`} title={`${editor.kind === 'rename' ? '重命名' : '删除'}${label}`}>
          {editor.kind === 'rename'
            ? <GraphNameForm {...form} label={`${label}名称`} current={target.name} onSave={name => save(isCanvas
              ? { type: 'renameCanvas', canvasId: target.id, name }
              : { type: 'renameTaskCard', taskCardId: target.id, name })} />
            : blocked ? <><p role="alert" className="text-sm text-err">{blocked}</p><Button onClick={form.onCancel}>取消</Button></>
              : <GraphDeleteForm {...form} onDelete={() => save(isCanvas
                ? { type: 'deleteCanvas', canvasId: target.id }
                : { type: 'deleteTaskCard', taskCardId: target.id })}>
                删除「{target.name}」及其在图中的关系和布局位置？
              </GraphDeleteForm>}
        </GraphEditor>
      }
      case 'createItem':
        if (!node || map) break
        return <GraphEditor key={`createItem:${node.id}`} title={`新建 TODO · ${node.name}`}>
          <GraphTodoForm {...form} onSave={draft => save({ type: 'createItem', taskCardId: node.id, ...draft })} />
        </GraphEditor>
      case 'addItem':
        if (!node || map) break
        return <GraphEditor key={`addItem:${node.id}`} title={`加入已有事项 · ${node.name}`}>
          <GraphAddForm {...form} workspace={workspace} onSave={workItemId => save({ type: 'placeItem', taskCardId: node.id, workItemId })} />
        </GraphEditor>
      case 'moveItem': {
        const placed = workspace.items.find(row => row.item.id === editor.id && row.taskCardId === editor.sourceCardId)
        if (!placed || !names.has(placed.taskCardId) || map) break
        return <GraphEditor key={`moveItem:${placed.item.id}`} title={`移动 TODO · ${placed.item.title}`}>
          <GraphMoveForm {...form} workspace={workspace} cardId={placed.taskCardId}
            onSave={taskCardId => save({ type: 'placeItem', taskCardId, workItemId: placed.item.id })} />
        </GraphEditor>
      }
      case 'createRelation':
      case 'editRelation':
        if (editor.kind === 'editRelation' && !relation) break
        return <GraphEditor key={`relation:${relation?.id ?? ''}`} title={relation ? '编辑关系' : '新建关系'}>
          <GraphRelationForm {...form} nodes={nodes} relation={relation} onSave={(from, to) => saveRelation(from, to, relation, true)} />
        </GraphEditor>
      case 'deleteRelation':
        if (!relation) break
        return <GraphEditor key={`deleteRelation:${relation.id}`} title="删除关系">
          <GraphDeleteForm {...form} onDelete={() => save({ type: 'deleteRelation', relationId: relation.id })}>
            删除关系「{relationLabel(relation)}」？
          </GraphDeleteForm>
        </GraphEditor>
    }
    return <GraphEditor key="missing" title="对象已不在当前视图">
      <Button onClick={form.onCancel}>关闭</Button>
    </GraphEditor>
  }

  if (!map && !canvas) return <ResourceState empty title="画布不存在" description="该画布可能已被删除。" />
  const context = menu && !list ? contextActions(menu.target) : undefined
  const inspector = renderInspector()
  const relationMode = !itemInspector && (selection?.kind === 'relations' || Boolean(selectedRelation))
  const settingsMode = !itemInspector && selection?.kind === 'settings'

  return <section className="min-w-0 space-y-3" aria-label={map ? 'Canvas Map' : '规划画布'}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      {map ? <h2 className={`text-base font-semibold text-txt ${list ? '' : 'sr-only'}`}>Canvas Map</h2>
        : <div className="flex min-w-0 items-center gap-2">
          <Link to={`${projectPath(workspace.project.id)}/map`} className="shrink-0 text-xs font-medium text-txt3 hover:text-accent-2">Canvas Map</Link>
          <span aria-hidden="true" className="text-txt3">›</span>
          <h2 title={canvas?.name} className="min-w-0 break-words text-sm font-semibold text-txt">{canvas?.name}</h2>
        </div>}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" icon="plus" variant="primary" disabled={busy} onClick={() => openEditor({ kind: 'create' })}>新建{noun}</Button>
        <Button size="sm" icon="workflow" disabled={busy || nodes.length < 2} onClick={() => openEditor({ kind: 'createRelation' })}>新建关系</Button>
        <Button size="sm" aria-pressed={relationMode} variant={relationMode ? 'secondary' : 'ghost'}
          onClick={() => showSelection(selection?.kind === 'relations' && !itemInspector ? null : { kind: 'relations' })}>关系</Button>
        {(!map || list) && <Button size="sm" variant="ghost" className="w-7 px-0" icon="refresh" aria-label="重置布局" title="重置布局"
          disabled={reset.disabled} onClick={reset.run} />}
        {!map && <Button size="sm" variant={settingsMode ? 'secondary' : 'ghost'} className="w-7 px-0" icon="settings" aria-pressed={settingsMode}
          aria-label="画布设置" title="画布设置" onClick={() => showSelection(settingsMode ? null : { kind: 'settings' })} />}
        {!compact && nodes.length > 0 && <Button size="sm" icon="menu" variant={list ? 'secondary' : 'ghost'} aria-pressed={list}
          onClick={() => { setMenu(undefined); setListMode(current => !current) }}>列表视图</Button>}
      </div>
    </div>
    {graphError && <p role="alert" className="break-words text-sm text-err">{graphError}</p>}
    {renderEditor()}
    {menu && context && <ContextMenu anchor={menu.anchor} {...context} onClose={() => setMenu(undefined)} />}
    <div className={`grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-3 [--wb-canvas-height:clamp(24rem,62dvh,52rem)] ${inspector ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]' : ''}`}>
      <div className="relative min-w-0">
        {list && !nodes.length ? <ResourceState empty title={map ? '暂无画布' : '暂无任务卡'}
          description={map ? '新建画布后即可组织项目。' : '新建任务卡后即可添加 TODO。'} />
          : list ? <ul aria-label={map ? '画布列表' : '任务卡列表'} className="divide-y divide-line border-y border-line">
            {nodes.map(node => <li key={node.id} className="min-w-0 space-y-2 py-3">
              <h3 className={`break-words text-sm font-semibold ${node.id === focusNodeId ? 'text-accent-2' : ''}`}
                ref={node.id === focusNodeId && !locatedItemId ? heading => { heading?.scrollIntoView?.({ block: 'nearest' }) } : undefined}>{node.name}</h3>
              {nodeContent(node)}
              {!map && taskActions(node)}
              {nodeActions(node, map)}
            </li>)}
          </ul> : <CanvasGraph
            key={JSON.stringify([lastReset <= layout.revision ? lastReset : 0, nodes.length])}
            nodes={nodes.map<CanvasNode>(node => ({ id: node.id, label: node.name, icon: map ? 'workflow' : 'layers', position: positions.get(node.id)!, content: nodeContent(node) }))}
            edges={relations}
            focusNodeId={focusNodeId}
            focusKey={focusKey}
            selection={graphSelection}
            editableEdges={!map && !busy}
            showMiniMap={nodes.length > 4}
            onMove={(id, position) => {
              if (positions.has(id)) savePositions({ ...Object.fromEntries(positions), [id]: position })
            }}
            onContext={(target, anchor) => setMenu({ target, anchor })}
            onSelection={value => { if (value || !itemInspector) showSelection(value) }}
            onOpenNode={map ? onCanvas : id => { if (!busy) openEditor({ kind: 'rename', id }) }}
            onConnect={(from, to) => saveRelation(from, to)}
            onReconnect={(id, from, to) => {
              const relation = relations.find(edge => edge.id === id)
              if (relation) saveRelation(from, to, relation)
            }}
          />}
        {!list && !nodes.length && <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="rounded-md bg-surface px-3 py-2 text-sm text-txt3">{map ? '暂无画布' : '暂无任务卡'}</p>
        </div>}
      </div>
      {inspector && <div className={`min-w-0 ${itemInspector || list ? 'order-first lg:order-last' : ''} ${itemInspector ? 'scroll-area lg:max-h-[var(--wb-canvas-height)] lg:overflow-y-auto' : ''}`}>{inspector}</div>}
    </div>
  </section>
}
