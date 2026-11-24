import { useState } from 'react'
import type { Priority, TaskStatus } from '@/api/types'
import { taskTimeInfo } from '@/lib/format'
import { errorMessage } from '@/lib/ui'
import { useTodoStore, type DetailState } from '@/store/todo-store'

const priorities: Priority[] = ['high', 'medium', 'low']
const statuses: TaskStatus[] = ['pending', 'in_progress', 'blocked', 'done', 'cancelled']

function TaskDetailForm({ detail }: { detail: DetailState }) {
  const task = detail.mode === 'view' ? detail.task : null
  const saveTask = useTodoStore((state) => state.saveTask)
  const removeTask = useTodoStore((state) => state.removeTask)
  const closeDetail = useTodoStore((state) => state.closeDetail)
  const setDetailConfirmDelete = useTodoStore((state) => state.setDetailConfirmDelete)

  const [title, setTitle] = useState(task?.title ?? '')
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'medium')
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'pending')
  const [tags, setTags] = useState(task?.tags.join(', ') ?? '')
  const [result, setResult] = useState(task?.result ?? '')

  const confirmDelete = detail.confirmDelete

  const save = () => {
    const trimmed = title.trim()
    if (!trimmed) {
      alert('Task title is required')
      return
    }
    // 完成任务必须写明结果，规则来自 todo-core 的状态机。
    if (status === 'done' && !result.trim()) {
      alert('Completing a task requires a result')
      return
    }
    const parsedTags = tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
    void saveTask({
      id: task?.id ?? null,
      title: trimmed,
      priority,
      status,
      tags: parsedTags,
      result: result.trim() ? result.trim() : null,
    }).catch((error) => alert(`Failed to save task: ${errorMessage(error)}`))
  }

  return (
    <div className="detail-panel">
      <div className="detail-header">
        <h3 className="detail-title">{detail.mode === 'new' ? 'New Task' : 'Task Details'}</h3>
        <button type="button" className="detail-close" onClick={closeDetail}>
          ×
        </button>
      </div>
      <div className="detail-body">
        <div className="form-group">
          <label className="form-label" htmlFor="detail-task-title">
            Title
          </label>
          <input
            id="detail-task-title"
            type="text"
            className="form-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus={detail.mode === 'new'}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="detail-task-priority">
            Priority
          </label>
          <select
            id="detail-task-priority"
            className="form-select"
            value={priority}
            onChange={(event) => setPriority(event.target.value as Priority)}
          >
            {priorities.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="detail-task-status">
            Status
          </label>
          <select
            id="detail-task-status"
            className="form-select"
            value={status}
            disabled={detail.mode === 'new'}
            onChange={(event) => setStatus(event.target.value as TaskStatus)}
          >
            {statuses.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="detail-task-tags">
            Tags
          </label>
          <input
            id="detail-task-tags"
            type="text"
            className="form-input"
            placeholder="tag1, tag2"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="detail-task-result">
            {status === 'done' ? 'Result (required)' : 'Result'}
          </label>
          <textarea
            id="detail-task-result"
            className="form-textarea"
            placeholder="Task completion notes"
            value={result}
            onChange={(event) => setResult(event.target.value)}
          />
        </div>
        <div className="form-group">
          <span className="form-label">Time Info</span>
          <div className="detail-time-content">
            {task ? taskTimeInfo(task) : 'New task'}
          </div>
        </div>
      </div>
      <div className="detail-footer">
        {confirmDelete && task ? (
          <div className="detail-delete-confirm">
            <span className="confirm-text">Delete task?</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setDetailConfirmDelete(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => {
                void removeTask(task.id).catch((error) =>
                  alert(`Failed to delete task: ${errorMessage(error)}`),
                )
              }}
            >
              Delete
            </button>
          </div>
        ) : (
          <div className="detail-actions">
            {task ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => setDetailConfirmDelete(true)}
              >
                Delete
              </button>
            ) : (
              <span />
            )}
            <button type="button" className="btn btn-primary" onClick={save}>
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function TaskDetailPanel() {
  const detail = useTodoStore((state) => state.detail)

  if (!detail) {
    return (
      <div className="detail-panel detail-panel-empty">
        <div className="detail-header">
          <h3 className="detail-title">Task Details</h3>
        </div>
        <div className="detail-empty">No task selected</div>
      </div>
    )
  }

  return <TaskDetailForm key={detail.mode === 'view' ? detail.task.id : 'new'} detail={detail} />
}
