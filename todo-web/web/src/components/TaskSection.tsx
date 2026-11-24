import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core'
import { useState } from 'react'
import type { Task, TaskStatus } from '@/api/types'
import { formatTaskTime, prioritySymbol, statusSymbol, STATUS_LABELS } from '@/lib/format'
import { copyText } from '@/lib/clipboard'
import { cx, errorMessage, readTaskDrag } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu'

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
      title={filtered ? `Show all tasks` : `Show only ${status} tasks`}
      onClick={() => toggleStatusFilter(status)}
    >
      <span className="status-symbol">{statusSymbol(status)}</span>
      <span className="status-name">{STATUS_LABELS[status]}</span>
      <span className="status-count">{count}</span>
    </button>
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
  const [copied, setCopied] = useState(false)

  const copyId = async () => {
    try {
      await copyText(task.id)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1000)
    } catch (error) {
      console.error('Failed to copy:', error)
    }
  }

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
      <td className="col-id">
        <button
          type="button"
          className={cx('task-id', copied && 'copied')}
          title="Click to copy"
          onClick={(event) => {
            event.stopPropagation()
            void copyId()
          }}
        >
          {copied ? 'copied!' : task.id}
        </button>
      </td>
      <td className={cx('col-title', `task-title-${task.status}`)}>{task.title}</td>
      <td className="col-tags">
        {task.tags.map((tag) => (
          <span key={tag} className="tag">
            {tag}
          </span>
        ))}
      </td>
      <td className="col-status" title={STATUS_LABELS[task.status]}>
        {statusSymbol(task.status)}
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
  const dayCounts = useTodoStore((state) => state.dayCounts)
  const dayFilter = useTodoStore((state) => state.dayFilter)
  const toggleDayFilter = useTodoStore((state) => state.toggleDayFilter)

  const openNewTask = useTodoStore((state) => state.openNewTask)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const openMenu: OpenMenu = (x, y, items, heading) => setMenu({ x, y, items, heading })

  const counts = statuses.reduce<Record<TaskStatus, number>>((result, status) => {
    result[status] = tasks.filter((task) => task.status === status).length
    return result
  }, {} as Record<TaskStatus, number>)
  const visibleTasks = statusFilter ? tasks.filter((task) => task.status === statusFilter) : tasks

  return (
    <section
      className="tasks-section"
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
          <div className="day-filter">
            <span className="day-filter-label">{dayFilter ? dayFilter.slice(5) : ''}</span>
            <div className="day-bars" role="group" aria-label="Tasks created in the last 7 days">
              {dayCounts.map(({ date, count }) => (
                <button
                  key={date}
                  type="button"
                  className={cx('day-bar', dayFilter === date && 'is-active')}
                  style={{ flexGrow: count }}
                  title={`${date} · ${count} ${count === 1 ? 'task' : 'tasks'}`}
                  aria-label={`${date}, ${count} tasks`}
                  aria-pressed={dayFilter === date}
                  onClick={() => {
                    void toggleDayFilter(date).catch((error) => alert(errorMessage(error)))
                  }}
                />
              ))}
            </div>
          </div>
          <div className="tasks-header-right">
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
          </div>
        </div>
      ) : null}
      <table className="task-table">
        <thead>
          <tr>
            <th className="col-priority">Pri</th>
            <th className="col-id">ID</th>
            <th className="col-title">Task</th>
            <th className="col-tags">Tags</th>
            <th className="col-status">Status</th>
            <th className="col-time">Time</th>
          </tr>
        </thead>
        <tbody>
          {tasksLoading ? (
            <tr>
              <td colSpan={6} className="empty-state">
                Loading...
              </td>
            </tr>
          ) : null}
          {!tasksLoading && visibleTasks.length === 0 ? (
            <tr>
              <td colSpan={6} className="empty-state">
                {!selectedProjectId
                  ? 'Select a project'
                  : statusFilter
                    ? `No ${statusFilter} tasks`
                    : dayFilter
                      ? `No tasks created on ${dayFilter}`
                      : 'No tasks'}
              </td>
            </tr>
          ) : null}
          {!tasksLoading
            ? visibleTasks.map((task) => <TaskRow key={task.id} task={task} openMenu={openMenu} />)
            : null}
        </tbody>
      </table>
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
