import { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { Priority, TaskStatus } from '@/api/types'
import { taskTimeInfo } from '@/lib/format'
import { copyText } from '@/lib/clipboard'
import { buildTaskMarkdown } from '@/lib/task-markdown'
import { cx, errorMessage } from '@/lib/ui'
import { useTodoStore, type DetailState } from '@/store/todo-store'

const MarkdownEditor = lazy(() => import('./MarkdownEditor'))

const priorities: Priority[] = ['high', 'medium', 'low']
const statuses: TaskStatus[] = ['pending', 'in_progress', 'blocked', 'done', 'cancelled']

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
  const closeDetail = useTodoStore((state) => state.closeDetail)

  const [title, setTitle] = useState(task?.title ?? '')
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'medium')
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'pending')
  const [tags, setTags] = useState(task?.tags?.join(', ') ?? '')
  const [note, setNote] = useState(task?.result ?? '')
  const [copied, setCopied] = useState(false)
  const [idCopied, setIdCopied] = useState(false)
  const [height, setHeight] = useState(readStoredHeight)

  const sheetRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const heightRef = useRef(height)

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
  }, [title, height])

  // 用 window 监听拖动：指针移出面板甚至移出窗口时也能继续调整。
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const sheet = sheetRef.current
    const panel = sheet?.parentElement
    if (!sheet || !panel) return
    event.preventDefault()

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
    applyHeight(DEFAULT_HEIGHT)
    localStorage.setItem(HEIGHT_KEY, String(DEFAULT_HEIGHT))
  }

  const copyId = async () => {
    if (!task) return
    try {
      await copyText(task.id)
      setIdCopied(true)
      window.setTimeout(() => setIdCopied(false), 1000)
    } catch (error) {
      alert(`Failed to copy task id: ${errorMessage(error)}`)
    }
  }

  const copyAsMarkdown = async () => {
    const markdown = buildTaskMarkdown({
      title,
      status,
      priority,
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      note,
      timeInfo: task ? taskTimeInfo(task) : null,
    })
    try {
      await copyText(markdown)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch (error) {
      alert(`Failed to copy task: ${errorMessage(error)}`)
    }
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
      sheetRef.current?.querySelector<HTMLElement>('.ProseMirror')?.focus()
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
      className="detail-sheet"
      style={{ height }}
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
        <div className="detail-heading">
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
          <div className="detail-tools">
            <button
              type="button"
              className={cx('detail-tool', copied && 'is-copied')}
              title={copied ? 'Copied' : 'Copy as Markdown'}
              aria-label="Copy task as Markdown"
              onClick={() => void copyAsMarkdown()}
            >
              {copied ? '✓' : '⧉'}
            </button>
          </div>
        </div>

        <div className="detail-meta">
          {task ? (
            <button
              type="button"
              className={cx('detail-inline-field', 'detail-id', idCopied && 'is-copied')}
              title="Click to copy task id"
              aria-label="Copy task id"
              onClick={() => void copyId()}
            >
              <span className="detail-inline-label">id</span>
              <span className="detail-inline-value">{idCopied ? 'copied!' : task.id}</span>
            </button>
          ) : null}
          <label className="detail-inline-field">
            <span className="detail-inline-label">status</span>
            <select
              className="detail-inline-select"
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
          </label>
          <label className="detail-inline-field">
            <span className="detail-inline-label">pri</span>
            <select
              className="detail-inline-select"
              value={priority}
              onChange={(event) => setPriority(event.target.value as Priority)}
            >
              {priorities.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="detail-inline-field">
            <span className="detail-inline-label">tags</span>
            <input
              className="detail-inline-input"
              type="text"
              placeholder="comma separated"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
          <span className="detail-meta-time">{task ? taskTimeInfo(task) : 'Not saved yet'}</span>
        </div>

        <div className="detail-note">
          <Suspense fallback={<p className="detail-note-empty">Loading editor…</p>}>
            <MarkdownEditor
              value={note}
              placeholder="Write notes: # heading, **bold**, - list"
              onChange={setNote}
            />
          </Suspense>
        </div>
      </div>

      <footer className="detail-footer">
        <div className="detail-modes">
          {missingResult ? <span className="detail-hint">Result required to finish</span> : null}
        </div>
        <div className="detail-actions">
          <button type="button" className="btn" onClick={closeDetail}>
            Close
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            Save
          </button>
        </div>
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
