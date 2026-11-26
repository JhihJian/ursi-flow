import { useId, useMemo } from 'react'
import { prioritySymbol, STATUS_LABELS } from '@/lib/format'
import { buildTaskGraph } from '@/lib/task-graph'
import { cx } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'
import { StatusIcon } from './StatusIcon'

/**
 * 任务关系图：`parent_id` 画成实线父子边，`pre_id` 画成虚线前置边。
 * 布局在 `lib/task-graph.ts` 算好，这里只画节点与连线。
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

  if (!hasProject) return <p className="empty-state">Select a project</p>
  if (loading && layout.nodes.length === 0) return <p className="empty-state">Loading...</p>
  if (layout.nodes.length === 0) return <p className="empty-state">No open tasks</p>

  return (
    <div className="task-graph" role="group" aria-label="任务关系图">
      <div
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
        </svg>
        {layout.nodes.map((node) => {
          const task = byId.get(node.id)
          return (
            <button
              key={node.id}
              type="button"
              className={cx(
                'task-graph-node',
                `is-${node.status}`,
                selectedId === node.id && 'is-selected',
              )}
              style={{
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
              }}
              title={`${node.title} · ${STATUS_LABELS[node.status]}`}
              onClick={() => {
                if (task) openTask(task)
              }}
            >
              <span className={cx('task-graph-priority', `priority-${node.priority}`)}>
                {prioritySymbol(node.priority)}
              </span>
              <span className="task-graph-title">{node.label}</span>
              <StatusIcon status={node.status} size={11} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
