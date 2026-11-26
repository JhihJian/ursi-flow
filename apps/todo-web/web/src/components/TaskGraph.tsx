import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { prioritySymbol, STATUS_LABELS } from '@/lib/format'
import {
  buildTaskGraph,
  type TaskGraphEdgeKind,
  type TaskGraphNode,
} from '@/lib/task-graph'
import { cx, errorMessage } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu'
import { StatusIcon } from './StatusIcon'

type SessionMode = TaskGraphEdgeKind | 'move'

interface DragSession {
  mode: SessionMode
  sourceId: string
  startX: number
  startY: number
  /** 移动时节点的起始坐标。 */
  originX: number
  originY: number
  /** 超过阈值或从端点按下后才真正开始拖拽。 */
  active: boolean
}

type GraphDrag =
  | {
      kind: 'link'
      mode: TaskGraphEdgeKind
      sourceId: string
      pointerX: number
      pointerY: number
      targetId: string | null
    }
  | { kind: 'move'; id: string; x: number; y: number }

/** 手动位置的最小值，避免拖出画布左上角。 */
const MIN_POSITION = 24

/** 拖动超过这个距离才把按下当成拖拽，普通点击仍然打开详情。 */
const DRAG_THRESHOLD = 6
/** 拖拽结束后紧跟的 click 不算点击。 */
const CLICK_SUPPRESS_MS = 300

function targetAt(x: number, y: number): string | null {
  const element = document.elementFromPoint(x, y)
  const host = element?.closest<HTMLElement>('[data-task-node]')
  return host?.dataset.taskNode ?? null
}

/**
 * 任务关系图：`parent_id` 显示为包含子任务的分组节点，`pre_id` 显示为前置依赖连线。
 * 拖动顶层节点调整位置并保存在浏览器本地；按住 Shift 拖到另一个节点上设父任务，
 * 从节点左侧端点拖到另一个任务，把它设为自己的前置（连成 目标 → 自己）；
 * 连线右键删除前置依赖，节点右键解除父子关系。
 */
export function TaskGraph() {
  const tasks = useTodoStore((state) => state.graphTasks)
  const loading = useTodoStore((state) => state.graphLoading)
  const hasProject = useTodoStore((state) => state.selectedProjectId !== null)
  const openTask = useTodoStore((state) => state.openTask)
  const openNewTask = useTodoStore((state) => state.openNewTask)
  const graphPositions = useTodoStore((state) => state.graphPositions)
  const resetGraphPosition = useTodoStore((state) => state.resetGraphPosition)
  const selectedId = useTodoStore((state) =>
    state.detail?.mode === 'view' ? state.detail.task.id : null,
  )

  const [drag, setDrag] = useState<GraphDrag | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  const positions = useMemo(
    () =>
      drag?.kind === 'move'
        ? { ...graphPositions, [drag.id]: { x: drag.x, y: drag.y } }
        : graphPositions,
    [graphPositions, drag],
  )
  const layout = useMemo(() => buildTaskGraph(tasks, positions), [tasks, positions])
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const nodesById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout],
  )
  const markerId = `task-graph-arrow-${useId().replace(/:/g, '')}`

  const canvasRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<DragSession | null>(null)
  const suppressClickUntil = useRef(0)

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const session = sessionRef.current
      if (!session) return
      if (!session.active) {
        const moved = Math.hypot(event.clientX - session.startX, event.clientY - session.startY)
        if (moved < DRAG_THRESHOLD) return
        session.active = true
      }
      if (session.mode === 'move') {
        setDrag({
          kind: 'move',
          id: session.sourceId,
          x: Math.max(MIN_POSITION, session.originX + event.clientX - session.startX),
          y: Math.max(MIN_POSITION, session.originY + event.clientY - session.startY),
        })
        return
      }
      const target = targetAt(event.clientX, event.clientY)
      setDrag({
        kind: 'link',
        mode: session.mode,
        sourceId: session.sourceId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        targetId: target === session.sourceId ? null : target,
      })
    }

    const finish = (event: PointerEvent, cancelled: boolean) => {
      const session = sessionRef.current
      sessionRef.current = null
      setDrag(null)
      if (!session?.active) return
      suppressClickUntil.current = Date.now() + CLICK_SUPPRESS_MS
      if (cancelled) return
      const store = useTodoStore.getState()
      if (session.mode === 'move') {
        store.setGraphPosition(session.sourceId, {
          x: Math.max(MIN_POSITION, session.originX + event.clientX - session.startX),
          y: Math.max(MIN_POSITION, session.originY + event.clientY - session.startY),
        })
        return
      }
      const targetId = targetAt(event.clientX, event.clientY)
      if (!targetId || targetId === session.sourceId) return
      const action =
        session.mode === 'parent'
          ? store.setTaskParent(session.sourceId, targetId)
          : store.setTaskPredecessor(session.sourceId, targetId)
      void action.catch((error) =>
        alert(`Failed to update task relation: ${errorMessage(error)}`),
      )
    }

    const handleUp = (event: PointerEvent) => finish(event, false)
    const handleCancel = (event: PointerEvent) => finish(event, true)
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleCancel)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleCancel)
    }
  }, [])

  if (!hasProject) return <p className="empty-state">Select a project</p>
  if (loading && layout.nodes.length === 0) return <p className="empty-state">Loading...</p>
  if (layout.nodes.length === 0) return <p className="empty-state">No open tasks</p>

  const beginLink = (
    event: ReactPointerEvent,
    sourceId: string,
    kind: TaskGraphEdgeKind,
    immediate: boolean,
  ) => {
    if (event.button !== 0) return
    const node = nodesById.get(sourceId)
    sessionRef.current = {
      mode: kind,
      sourceId,
      startX: event.clientX,
      startY: event.clientY,
      originX: node?.x ?? 0,
      originY: node?.y ?? 0,
      active: immediate,
    }
    if (!immediate) return
    // 端点没有点击行为，按下即开始连线，同时挡住节点自己的按下处理。
    event.preventDefault()
    setDrag({
      kind: 'link',
      mode: kind,
      sourceId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      targetId: null,
    })
  }

  const removeRelation = (action: Promise<void>) => {
    void action.catch((error) =>
      alert(`Failed to remove task relation: ${errorMessage(error)}`),
    )
  }

  const openNodeMenu = (event: React.MouseEvent, node: TaskGraphNode) => {
    event.preventDefault()
    event.stopPropagation()
    const items: MenuItem[] = []
    if (node.parentId) {
      const store = useTodoStore.getState()
      items.push({
        label: 'Remove parent',
        onSelect: () => removeRelation(store.setTaskParent(node.id, null)),
      })
    }
    if (node.parentId === null && graphPositions[node.id]) {
      items.push({
        label: 'Reset position',
        onSelect: () => resetGraphPosition(node.id),
      })
    }
    items.push({ label: 'New task', onSelect: openNewTask })
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  const pending = pendingPath(drag, nodesById, canvasRef.current)

  return (
    <div className="task-graph" role="group" aria-label="任务关系图">
      <div
        ref={canvasRef}
        className="task-graph-canvas"
        style={{ width: layout.width, height: layout.height }}
      >
        {layout.nodes
          .filter((node) => node.childIds.length > 0)
          .map((node) => (
            <div
              key={`frame-${node.id}`}
              data-task-node={node.id}
              className={cx(
                'task-graph-frame',
                drag?.kind === 'link' && drag.targetId === node.id && 'is-drop-target',
              )}
              style={{
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
              }}
              onContextMenu={(event) => openNodeMenu(event, node)}
            />
          ))}
        <svg
          className="task-graph-edges"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" className="task-graph-arrow" />
            </marker>
          </defs>
          {layout.edges.map((edge) => (
            <g key={`${edge.from}->${edge.to}`}>
              <path
                d={edge.path}
                className={cx('task-graph-edge', edge.back && 'is-back')}
                markerEnd={`url(#${markerId})`}
              />
              <path
                d={edge.path}
                className="task-graph-edge-hit"
                data-edge-from={edge.from}
                data-edge-to={edge.to}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  const store = useTodoStore.getState()
                  setMenu({
                    x: event.clientX,
                    y: event.clientY,
                    items: [
                      {
                        label: 'remove',
                        onSelect: () =>
                          removeRelation(store.setTaskPredecessor(edge.to, null)),
                      },
                    ],
                  })
                }}
              />
            </g>
          ))}
          {pending === null ? null : (
            <path
              d={pending}
              className={cx(
                'task-graph-pending',
                drag?.kind === 'link' && drag.mode === 'pre' && 'is-pre',
              )}
              markerEnd={`url(#${markerId})`}
            />
          )}
        </svg>
        {layout.nodes.map((node) => {
          const task = byId.get(node.id)
          return (
            <div
              key={node.id}
              data-task-node={node.id}
              className={cx(
                'task-graph-node',
                node.childIds.length > 0 ? 'is-group' : 'is-leaf',
                `is-${node.status}`,
                selectedId === node.id && 'is-selected',
                node.parentId === null && 'is-movable',
                drag?.kind === 'link' && drag.sourceId === node.id && 'is-linking',
                drag?.kind === 'move' && drag.id === node.id && 'is-moving',
                drag?.kind === 'link' && drag.targetId === node.id && 'is-drop-target',
              )}
              style={{
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.headerHeight,
              }}
              role="button"
              tabIndex={0}
              title={`${node.title} · ${STATUS_LABELS[node.status]}`}
              onClick={() => {
                if (Date.now() < suppressClickUntil.current) return
                if (task) openTask(task)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                if (task) openTask(task)
              }}
              onContextMenu={(event) => openNodeMenu(event, node)}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                // 按住 Shift 拖到别的节点上建立父子关系，直接拖则调整位置。
                if (event.shiftKey) {
                  beginLink(event, node.id, 'parent', false)
                  return
                }
                if (node.parentId !== null) return
                sessionRef.current = {
                  mode: 'move',
                  sourceId: node.id,
                  startX: event.clientX,
                  startY: event.clientY,
                  originX: node.x,
                  originY: node.y,
                  active: false,
                }
              }}
            >
              <button
                type="button"
                className="task-graph-port"
                aria-label={`拖动到另一个任务上，把它设为 ${node.title} 的前置`}
                title="拖到另一个任务上，把它设为这个任务的前置"
                onPointerDown={(event) => {
                  event.stopPropagation()
                  beginLink(event, node.id, 'pre', true)
                }}
                onClick={(event) => event.stopPropagation()}
              />
              <span className={cx('task-graph-priority', `priority-${node.priority}`)}>
                {prioritySymbol(node.priority)}
              </span>
              <span className="task-graph-title">{node.label}</span>
              {node.childIds.length > 0 ? (
                <span className="task-graph-count">{node.childIds.length}</span>
              ) : null}
              <StatusIcon status={node.status} size={11} />
            </div>
          )
        })}
      </div>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  )
}

/** 拖拽过程中的临时连线：父子从节点右侧拉出，前置从左侧端点拉出。 */
function pendingPath(
  drag: GraphDrag | null,
  nodes: Map<string, TaskGraphNode>,
  canvas: HTMLDivElement | null,
): string | null {
  if (drag?.kind !== 'link' || !canvas) return null
  const source = nodes.get(drag.sourceId)
  if (!source) return null
  const rect = canvas.getBoundingClientRect()
  const x2 = drag.pointerX - rect.left
  const y2 = drag.pointerY - rect.top
  const x1 = drag.mode === 'parent' ? source.x + source.width : source.x
  const y1 = source.y + source.headerHeight / 2
  // 前置依赖的拖拽方向表示“目标 -> 自己”，预览箭头画在节点这一端。
  if (drag.mode === 'pre') return `M ${x2} ${y2} L ${x1} ${y1}`
  return `M ${x1} ${y1} L ${x2} ${y2}`
}
