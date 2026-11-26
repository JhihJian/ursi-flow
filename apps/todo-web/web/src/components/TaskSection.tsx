import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core'
import { useState } from 'react'
import type { Task, TaskStatus } from '@/api/types'
import { formatTaskTime, prioritySymbol, STATUS_LABELS } from '@/lib/format'
import { cx, errorMessage, readTaskDrag } from '@/lib/ui'
import { useTodoStore, type TaskView } from '@/store/todo-store'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu'
import { DayFilter } from './DayFilter'
import { StatusIcon } from './StatusIcon'
import { TaskGraph } from './TaskGraph'

type OpenMenu = (x: number, y: number, items: MenuItem[], heading?: string) => void

const statuses: TaskStatus[] = ['pending', 'in_progress', 'blocked', 'done']

function StatusTarget({
  status,
  count,
  filtered,
}: {
  status: TaskStatus
  count: number
  filtered: boolean
}) {
  const { active } = useDndContext()
  const toggleStatusFilter = useTodoStore((state) => state.toggleStatusFilter)
  const dragging = readTaskDrag(active?.data.current) !== null
  const { setNodeRef, isOver } = useDroppable({
    id: `status-${status}`,
    data: { type: 'status', status },
  })
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={cx(
        'status-target',
        filtered && 'is-active',
        dragging && 'drop-ready',
        isOver && 'is-over',
      )}
      aria-pressed={filtered}
      aria-label={`${STATUS_LABELS[status]}: ${count} tasks`}
      title={filtered ? `Show all tasks` : `Show only ${status} tasks`}
      onClick={() => toggleStatusFilter(status)}
    >
      <StatusIcon status={status} />
      <span className="status-count">{count}</span>
    </button>
  )
}

function ViewSwitch({ view, onChange }: { view: TaskView; onChange: (view: TaskView) => void }) {
  return (
    <div className="view-switch" role="group" aria-label="任务视图">
      <button
        type="button"
        className={cx('view-tab', view === 'list' && 'is-active')}
        aria-pressed={view === 'list'}
        title="任务表"
        onClick={() => onChange('list')}
      >
        列表
      </button>
      <button
        type="button"
        className={cx('view-tab', view === 'graph' && 'is-active')}
        aria-pressed={view === 'graph'}
        title="按父子与前置关系展示任务"
        onClick={() => onChange('graph')}
      >
        图
      </button>
    </div>
  )
}

function TaskRow({
  task,
  openMenu,
}: {
  task: Task
  openMenu: OpenMenu
}) {
  const openTask = useTodoStore((state) => state.openTask)
  const openNewTask = useTodoStore((state) => state.openNewTask)
  const removeTask = useTodoStore((state) => state.removeTask)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { type: 'task', task },
  })
  const selected = useTodoStore(
    (state) => state.detail?.mode === 'view' && state.detail.task.id === task.id,
  )

  const menuItems: MenuItem[] = [
    { label: 'New task', onSelect: openNewTask },
    {
      label: 'Delete task',
      danger: true,
      onSelect: () => {
        const confirmItems: MenuItem[] = [
          {
            label: 'Delete task',
            danger: true,
            onSelect: () => {
              void removeTask(task.id).catch((error) =>
                alert(`Failed to delete task: ${errorMessage(error)}`),
              )
            },
          },
          { label: 'Cancel', onSelect: () => {} },
        ]
        const rect = document
          .querySelector(`[data-task-id="${task.id}"]`)
          ?.getBoundingClientRect()
        openMenu(rect?.left ?? 0, (rect?.bottom ?? 0) + 4, confirmItems, `Delete "${task.title}"?`)
      },
    },
  ]

  return (
    <tr
      ref={setNodeRef}
      data-task-id={task.id}
      className={cx(
        `status-${task.status}`,
        selected && 'is-selected',
        isDragging && 'is-dragging',
      )}
      onClick={() => openTask(task)}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openMenu(event.clientX, event.clientY, menuItems)
      }}
    >
      <td className="col-priority">
        <span
          className="drag-handle"
          title="Drag to change status or project"
          aria-label={`Drag ${task.title}`}
          {...listeners}
          {...attributes}
        >
          <span className="drag-grip" aria-hidden="true">
            ⠿
          </span>
          <span className={cx('drag-priority', `priority-${task.priority}`)}>
            {prioritySymbol(task.priority)}
          </span>
        </span>
      </td>
      <td className={cx('col-title', `task-title-${task.status}`)}>{task.title}</td>
      <td className="col-status" title={STATUS_LABELS[task.status]}>
        <StatusIcon status={task.status} />
      </td>
      <td className="col-time">{formatTaskTime(task)}</td>
    </tr>
  )
}

export function TaskSection() {
  const tasks = useTodoStore((state) => state.tasks)
  const tasksLoading = useTodoStore((state) => state.tasksLoading)
  const selectedProjectId = useTodoStore((state) => state.selectedProjectId)
  const statusFilter = useTodoStore((state) => state.statusFilter)
  const dayFilter = useTodoStore((state) => state.dayFilter)
  const view = useTodoStore((state) => state.view)
  const setView = useTodoStore((state) => state.setView)
  const graphPositions = useTodoStore((state) => state.graphPositions)
  const clearGraphPositions = useTodoStore((state) => state.clearGraphPositions)

  const openNewTask = useTodoStore((state) => state.openNewTask)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const openMenu: OpenMenu = (x, y, items, heading) => setMenu({ x, y, items, heading })

  const changeView = (next: TaskView) => {
    void setView(next).catch((error) => alert(`Failed to load task graph: ${errorMessage(error)}`))
  }

  const counts = statuses.reduce<Record<TaskStatus, number>>((result, status) => {
    result[status] = tasks.filter((task) => task.status === status).length
    return result
  }, {} as Record<TaskStatus, number>)
  const visibleTasks = statusFilter ? tasks.filter((task) => task.status === statusFilter) : tasks

  return (
    <section
      className={cx('tasks-section', view === 'graph' && 'is-graph')}
      onContextMenu={(event) => {
        // 行右键自己处理；落在列表空白处时只给新建任务。
        if (!selectedProjectId) return
        event.preventDefault()
        openMenu(event.clientX, event.clientY, [
          { label: 'New task', onSelect: openNewTask },
        ])
      }}
    >
      {selectedProjectId ? (
        <div className="tasks-header">
          {view === 'graph' ? (
            <p className="task-graph-hint">
              <span>分组是子任务 · 虚线是前置依赖 · 完成项仅在与未完成任务相关时出现</span>
              <span>拖节点调整位置（保存在本机）；Shift 拖到目标设父任务；左侧方形加号拖到目标，把目标设为自己的前置</span>
            </p>
          ) : (
            <DayFilter />
          )}
          <div className="tasks-header-right">
            {view === 'list' ? (
              <div className="status-targets">
                {statuses.map((status) => (
                  <StatusTarget
                    key={status}
                    status={status}
                    count={counts[status] ?? 0}
                    filtered={statusFilter === status}
                  />
                ))}
              </div>
            ) : null}
            {view === 'graph' ? (
              <button
                type="button"
                className="graph-reset"
                title="清空手动位置，恢复自动排版"
                disabled={Object.keys(graphPositions).length === 0}
                onClick={clearGraphPositions}
              >
                Reset layout
              </button>
            ) : null}
            <ViewSwitch view={view} onChange={changeView} />
          </div>
        </div>
      ) : null}
      {view === 'graph' ? (
        <TaskGraph />
      ) : (
        <table className="task-table">
          <thead>
            <tr>
              <th className="col-priority">Pri</th>
              <th className="col-title">Task</th>
              <th className="col-status">Status</th>
              <th className="col-time">Time</th>
            </tr>
          </thead>
          <tbody>
            {tasksLoading ? (
              <tr>
                <td colSpan={4} className="empty-state">
                  Loading...
                </td>
              </tr>
            ) : null}
            {!tasksLoading && visibleTasks.length === 0 ? (
              <tr>
                <td colSpan={4} className="empty-state">
                  {!selectedProjectId
                    ? 'Select a project'
                    : statusFilter
                      ? `No ${statusFilter} tasks`
                      : dayFilter.length > 1
                        ? `No tasks created in the selected ${dayFilter.length} days`
                        : dayFilter.length === 1
                          ? `No tasks created on ${dayFilter[0]}`
                          : 'No tasks'}
                </td>
              </tr>
            ) : null}
            {!tasksLoading
              ? visibleTasks.map((task) => (
                  <TaskRow key={task.id} task={task} openMenu={openMenu} />
                ))
              : null}
          </tbody>
        </table>
      )}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </section>
  )
}

export function TaskDragPreview({ task }: { task: Task }) {
  return (
    <div className="drag-preview">
      <span className={cx('drag-preview-priority', `priority-${task.priority}`)}>
        {prioritySymbol(task.priority)}
      </span>
      <span className="drag-preview-title">{task.title}</span>
    </div>
  )
}
