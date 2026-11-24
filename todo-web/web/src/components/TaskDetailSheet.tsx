import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Priority, TaskStatus } from '@/api/types'
import { taskTimeInfo } from '@/lib/format'
import { cx, errorMessage } from '@/lib/ui'
import { useTodoStore, type DetailState } from '@/store/todo-store'

const priorities: Priority[] = ['high', 'medium', 'low']
const statuses: TaskStatus[] = ['pending', 'in_progress', 'blocked', 'done', 'cancelled']

const MarkdownPreview = lazy(() => import('./MarkdownPreview'))

const HEIGHT_KEY = 'todo-web.detail-height'
const DEFAULT_HEIGHT = 360
const MIN_HEIGHT = 200
/** 面板上方至少留给任务列表的高度。 */
const LIST_RESERVE = 120

function readStoredHeight(): number {
  const stored = Number(localStorage.getItem(HEIGHT_KEY))
  return Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT
}

function clampHeight(value: number, panelHeight: number): number {
  const max = Math.max(MIN_HEIGHT, panelHeight - LIST_RESERVE)
  return Math.min(Math.max(value, MIN_HEIGHT), max)
}

function TaskDetailEditor({ detail }: { detail: DetailState }) {
  const task = detail.mode === 'view' ? detail.task : null
  const saveTask = useTodoStore((state) => state.saveTask)
  const removeTask = useTodoStore((state) => state.removeTask)
  const closeDetail = useTodoStore((state) => state.closeDetail)
  const setDetailConfirmDelete = useTodoStore((state) => state.setDetailConfirmDelete)

  const [title, setTitle] = useState(task?.title ?? '')
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'medium')
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'pending')
  const [tags, setTags] = useState(task?.tags?.join(', ') ?? '')
  const [note, setNote] = useState(task?.result ?? '')
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const [height, setHeight] = useState(readStoredHeight)
  const [maximized, setMaximized] = useState(false)

  const sheetRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const heightRef = useRef(height)

  const confirmDelete = detail.confirmDelete
  const missingResult = status === 'done' && !note.trim()

  const applyHeight = useCallback((next: number) => {
    heightRef.current = next
    setHeight(next)
  }, [])

  // 标题框跟随内容长高，保持一行行文连续。
  useLayoutEffect(() => {
    const element = titleRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [title, maximized, height])

  useEffect(() => {
    const element = noteRef.current
    if (!element) return
    element.scrollTop = 0
  }, [task?.id])

  // 用 window 监听拖动：指针移出面板甚至移出窗口时也能继续调整。
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const sheet = sheetRef.current
    const panel = sheet?.parentElement
    if (!sheet || !panel) return
    event.preventDefault()
    setMaximized(false)

    const drag = {
      startY: event.clientY,
      startHeight: sheet.getBoundingClientRect().height,
      panelHeight: panel.clientHeight,
    }

    const onMove = (moveEvent: PointerEvent) => {
      applyHeight(
        clampHeight(drag.startHeight + (drag.startY - moveEvent.clientY), drag.panelHeight),
      )
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      localStorage.setItem(HEIGHT_KEY, String(Math.round(heightRef.current)))
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const resetHeight = () => {
    setMaximized(false)
    applyHeight(DEFAULT_HEIGHT)
    localStorage.setItem(HEIGHT_KEY, String(DEFAULT_HEIGHT))
  }

  const save = () => {
    const trimmed = title.trim()
    if (!trimmed) {
      alert('Task title is required')
      titleRef.current?.focus()
      return
    }
    // 完成任务必须写明结果，规则来自 todo-core 的状态机。
    if (missingResult) {
      alert('Completing a task requires a result')
      setMode('write')
      noteRef.current?.focus()
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
      result: note.trim() ? note : null,
    }).catch((error) => alert(`Failed to save task: ${errorMessage(error)}`))
  }

  return (
    <section
      ref={sheetRef}
      className={cx('detail-sheet', maximized && 'is-maximized')}
      style={maximized ? undefined : { height }}
      role="dialog"
      aria-modal="false"
      aria-label={detail.mode === 'new' ? 'New task' : 'Task details'}
    >
      <div
        className="detail-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize task details"
        title="Drag to resize, double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={resetHeight}
      >
        <span className="detail-grip-dots" aria-hidden="true">
          ⋯
        </span>
      </div>

      <div className="detail-doc">
        <textarea
          ref={titleRef}
          className="detail-title-input"
          rows={1}
          placeholder="Task title"
          value={title}
          aria-label="Title"
          onChange={(event) => setTitle(event.target.value)}
          autoFocus={detail.mode === 'new'}
        />

        <div className="detail-meta">
          <select
            className="detail-inline-select"
            value={status}
            aria-label="Status"
            disabled={detail.mode === 'new'}
            onChange={(event) => setStatus(event.target.value as TaskStatus)}
          >
            {statuses.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            className="detail-inline-select"
            value={priority}
            aria-label="Priority"
            onChange={(event) => setPriority(event.target.value as Priority)}
          >
            {priorities.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <input
            className="detail-inline-input"
            type="text"
            placeholder="tags, comma separated"
            value={tags}
            aria-label="Tags"
            onChange={(event) => setTags(event.target.value)}
          />
          <span className="detail-meta-time">{task ? taskTimeInfo(task) : 'Not saved yet'}</span>
          <div className="detail-tools">
            <button
              type="button"
              className="detail-tool"
              title={maximized ? 'Restore height' : 'Expand'}
              aria-label={maximized ? 'Restore height' : 'Expand task details'}
              aria-pressed={maximized}
              onClick={() => setMaximized((value) => !value)}
            >
              {maximized ? '⤡' : '⤢'}
            </button>
            <button
              type="button"
              className="detail-tool"
              title="Close"
              aria-label="Close task details"
              onClick={closeDetail}
            >
              ×
            </button>
          </div>
        </div>

        <div className="detail-note">
          {mode === 'write' ? (
            <textarea
              ref={noteRef}
              className="detail-note-input"
              placeholder="Write notes in Markdown: **bold**, `code`, - list"
              value={note}
              aria-label="Notes"
              onChange={(event) => setNote(event.target.value)}
            />
          ) : (
            <div className="detail-note-preview">
              {note.trim() ? (
                <Suspense fallback={<p className="detail-note-empty">Rendering…</p>}>
                  <MarkdownPreview source={note} />
                </Suspense>
              ) : (
                <p className="detail-note-empty">Nothing written yet</p>
              )}
            </div>
          )}
        </div>
      </div>

      <footer className="detail-footer">
        <div className="detail-modes" role="group" aria-label="Editor mode">
          <button
            type="button"
            className={cx('detail-mode', mode === 'write' && 'active')}
            aria-pressed={mode === 'write'}
            onClick={() => setMode('write')}
          >
            Write
          </button>
          <button
            type="button"
            className={cx('detail-mode', mode === 'preview' && 'active')}
            aria-pressed={mode === 'preview'}
            onClick={() => setMode('preview')}
          >
            Preview
          </button>
          {missingResult ? <span className="detail-hint">Result required to finish</span> : null}
        </div>
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
            ) : null}
            <button type="button" className="btn btn-primary" onClick={save}>
              Save
            </button>
          </div>
        )}
      </footer>
    </section>
  )
}

/** 任务详情停靠在任务列表下方，打开时从下往上弹出。 */
export function TaskDetailSheet() {
  const detail = useTodoStore((state) => state.detail)
  if (!detail) return null
  return <TaskDetailEditor key={detail.mode === 'view' ? detail.task.id : 'new'} detail={detail} />
}
