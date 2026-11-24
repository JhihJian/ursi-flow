import { useDraggable, useDroppable } from '@dnd-kit/core'
import type { Task, TaskStatus } from '@/api/types'
import { formatTaskTime, prioritySymbol, statusSymbol, STATUS_LABELS } from '@/lib/format'
import { cx } from '@/lib/ui'
import { useTodoStore } from '@/store/todo-store'
import { useState } from 'react'

const statuses: TaskStatus[] = ['pending', 'in_progress', 'blocked', 'done']

function StatusTarget({ status, count }: { status: TaskStatus; count: number }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `status-${status}`,
    data: { type: 'status', status },
  })
  return (
    <div ref={setNodeRef} className={cx('status-target', isOver && 'is-over')}>
      <span className="status-symbol">{statusSymbol(status)}</span>
      <span className="status-name">{STATUS_LABELS[status]}</span>
      <span className="status-count">{count}</span>
    </div>
  )
}

function TaskRow({ task }: { task: Task }) {
  const openTask = useTodoStore((state) => state.openTask)
  const setDetailConfirmDelete = useTodoStore((state) => state.setDetailConfirmDelete)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { type: 'task', task },
  })
  const [copied, setCopied] = useState(false)

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(task.id)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1000)
    } catch (error) {
      console.error('Failed to copy:', error)
    }
  }

  return (
    <tr
      ref={setNodeRef}
      className={cx(`status-${task.status}`, isDragging && 'is-dragging')}
      onClick={() => openTask(task)}
    >
      <td className={cx('col-priority', `priority-${task.priority}`)}>
        <span
          className="drag-handle"
          title="Drag to change status or project"
          {...listeners}
          {...attributes}
        >
          {prioritySymbol(task.priority)}
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
      <td className="col-status">{task.status}</td>
      <td className="col-time">{formatTaskTime(task)}</td>
      <td className="col-actions">
        <div className="task-actions">
          <button
            type="button"
            className="icon-btn delete-btn"
            onClick={(event) => {
              event.stopPropagation()
              openTask(task)
              setDetailConfirmDelete(true)
            }}
          >
            del
          </button>
        </div>
      </td>
    </tr>
  )
}

export function TaskSection() {
  const tasks = useTodoStore((state) => state.tasks)
  const tasksLoading = useTodoStore((state) => state.tasksLoading)
  const selectedProjectId = useTodoStore((state) => state.selectedProjectId)

  const counts = statuses.reduce<Record<TaskStatus, number>>((result, status) => {
    result[status] = tasks.filter((task) => task.status === status).length
    return result
  }, {} as Record<TaskStatus, number>)

  return (
    <section className="tasks-section">
      <div className="tasks-header">
        <h3 className="section-title">Tasks</h3>
        {selectedProjectId ? (
          <div className="status-targets">
            {statuses.map((status) => (
              <StatusTarget key={status} status={status} count={counts[status] ?? 0} />
            ))}
          </div>
        ) : null}
      </div>
      <table className="task-table">
        <thead>
          <tr>
            <th className="col-priority">Pri</th>
            <th className="col-id">ID</th>
            <th className="col-title">Task</th>
            <th className="col-tags">Tags</th>
            <th className="col-status">Status</th>
            <th className="col-time">Time</th>
            <th className="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {tasksLoading ? (
            <tr>
              <td colSpan={7} className="empty-state">
                Loading...
              </td>
            </tr>
          ) : null}
          {!tasksLoading && tasks.length === 0 ? (
            <tr>
              <td colSpan={7} className="empty-state">
                {selectedProjectId ? 'No tasks' : 'Select a project'}
              </td>
            </tr>
          ) : null}
          {!tasksLoading ? tasks.map((task) => <TaskRow key={task.id} task={task} />) : null}
        </tbody>
      </table>
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
