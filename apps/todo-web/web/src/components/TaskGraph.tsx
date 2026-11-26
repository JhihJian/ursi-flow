import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { prioritySymbol, STATUS_LABELS } from '@/lib/format'
import { buildTaskGraph, type TaskGraphEdgeKind, type TaskGraphNode } from '@/lib/task-graph'
import { cx, errorMessage } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'
import { StatusIcon } from './StatusIcon'

interface LinkSession {
  sourceId: string
  kind: TaskGraphEdgeKind
  startX: number
  startY: number
  /** 超过阈值或从端点按下后才真正开始拖拽。 */
  active: boolean
}

interface LinkDrag {
  sourceId: string
  kind: TaskGraphEdgeKind
  pointerX: number
  pointerY: number
  targetId: string | null
}

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
 * 任务关系图：`parent_id` 画成实线父子边，`pre_id` 画成虚线前置边。
 * 布局在 `lib/task-graph.ts` 算好，这里负责画节点、连线，以及两种建立关系的拖拽：
 * 拖动节点叠到另一个节点上设父任务，从节点左侧端点拖到目标设前置任务。
 */
export function TaskGraph() {
  const tasks = useTodoStore((state) => state.graphTasks)
  const loading = useTodoStore((state) => state.graphLoading)
  const hasProject = useTodoStore((state) => state.selectedProjectId !== null)
  const openTask = useTodoStore((state) => state.openTask)
  const selectedId = useTodoStore((state) =>
    state.detail?.mode === 'view' ? state.detail.task.id : null,
  )

  const layout = useMemo(() => buildTaskGraph(tasks), [tasks])
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const markerId = `task-graph-arrow-${useId().replace(/:/g, '')}`

  const canvasRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<LinkSession | null>(null)
  const suppressClickUntil = useRef(0)
  const [drag, setDrag] = useState<LinkDrag | null>(null)

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const session = sessionRef.current
      if (!session) return
      if (!session.active) {
        const moved = Math.hypot(event.clientX - session.startX, event.clientY - session.startY)
        if (moved < DRAG_THRESHOLD) return
        session.active = true
      }
      const target = targetAt(event.clientX, event.clientY)
      setDrag({
        sourceId: session.sourceId,
        kind: session.kind,
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
      const targetId = targetAt(event.clientX, event.clientY)
      if (!targetId || targetId === session.sourceId) return
      const store = useTodoStore.getState()
      const action =
        session.kind === 'parent'
          ? store.setTaskParent(session.sourceId, targetId)
          : store.setTaskPredecessor(targetId, session.sourceId)
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
    sessionRef.current = {
      sourceId,
      kind,
      startX: event.clientX,
      startY: event.clientY,
      active: immediate,
    }
    if (!immediate) return
    // 端点没有点击行为，按下即开始连线，同时挡住节点自己的按下处理。
    event.preventDefault()
    setDrag({
      sourceId,
      kind,
      pointerX: event.clientX,
      pointerY: event.clientY,
      targetId: null,
    })
  }

  const pending = pendingPath(drag, layout.nodes, canvasRef.current)

  return (
    <div className="task-graph" role="group" aria-label="任务关系图">
      <div
        ref={canvasRef}
        className="task-graph-canvas"
        style={{ width: layout.width, height: layout.height }}
      >
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
            <path
              key={`${edge.kind}:${edge.from}->${edge.to}`}
              d={edge.path}
              className={cx(
                'task-graph-edge',
                `edge-${edge.kind}`,
                edge.back && 'is-back',
              )}
              markerEnd={`url(#${markerId})`}
            />
          ))}
          {pending === null ? null : (
            <path
              d={pending}
              className={cx('task-graph-pending', drag?.kind === 'pre' && 'is-pre')}
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
                `is-${node.status}`,
                selectedId === node.id && 'is-selected',
                drag?.sourceId === node.id && 'is-linking',
                drag?.targetId === node.id && 'is-drop-target',
              )}
              style={{
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
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
              onPointerDown={(event) => beginLink(event, node.id, 'parent', false)}
            >
              <button
                type="button"
                className="task-graph-port"
                aria-label={`拖动以把 ${node.title} 设为另一个任务的前置`}
                title="拖到另一个任务上，把这个任务设为它的前置"
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
              <StatusIcon status={node.status} size={11} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 拖拽过程中的临时连线：父子从节点右侧拉出，前瞻从左侧端点拉出。 */
function pendingPath(
  drag: LinkDrag | null,
  nodes: TaskGraphNode[],
  canvas: HTMLDivElement | null,
): string | null {
  if (!drag || !canvas) return null
  const source = nodes.find((node) => node.id === drag.sourceId)
  if (!source) return null
  const rect = canvas.getBoundingClientRect()
  const x2 = drag.pointerX - rect.left
  const y2 = drag.pointerY - rect.top
  const x1 = drag.kind === 'parent' ? source.x + source.width : source.x
  const y1 = source.y + source.height / 2
  return `M ${x1} ${y1} L ${x2} ${y2}`
}
