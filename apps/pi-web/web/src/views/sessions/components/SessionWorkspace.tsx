import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parsePiJsonl, TrajectoryViewer } from 'pi-agent-trajectory-viewer'
import type { SessionRow } from '../api'
import { formatBytes, formatWhen, sessionTitle } from '../lib/format'
import { errorText, useSessionsController } from '../sessions-context'
import { RefreshIcon } from './Icons'
import { RootPicker } from './RootPicker'

type LoadState =
  | { status: 'idle' }
  | { status: 'loading'; row: SessionRow }
  | { status: 'ready'; row: SessionRow; text: string }
  | { status: 'error'; row: SessionRow; message: string }

const LEGEND = [
  { kind: 'user', label: '用户' },
  { kind: 'message', label: '助手消息' },
  { kind: 'tool', label: '工具' },
  { kind: 'subtool', label: '子工具' },
  { kind: 'context', label: '上下文' },
  { kind: 'error', label: '错误' },
]

/** 时间线色块与记录类型一一对应，这里给出对照。 */
function Legend() {
  return (
    <div className="viewer-legend" aria-label="时间线配色">
      {LEGEND.map((item) => (
        <span className="viewer-legend-item" key={item.kind}>
          <span className={`viewer-swatch viewer-swatch-${item.kind}`} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </div>
  )
}

/**
 * 工作区：会话头部一行元信息 + 轨迹视图。渲染交给组件库，这里只做加载与状态。
 * 选中来自模块共享状态，侧边栏与这里读同一份。
 */
export function SessionWorkspace() {
  const { root, selected, api, picking, setPicking, setRoot, config, canResumeInChat, resumeInChat } = useSessionsController()
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const [state, setState] = useState<LoadState>({ status: 'idle' })
  const [revision, setRevision] = useState(0)

  const selectedId = selected?.id ?? null
  /**
   * 正文只在会话 id、根目录、手动刷新或文件的活动时间变化时重读。
   * 大文件不自动跟随：整份重下与重解析的成本按体积线性增长，交给手动刷新。
   */
  const autoFollow = (selected?.size ?? 0) <= 8 * 1024 * 1024
  const activity = autoFollow ? (selected?.modified ?? 0) : 0
  const rowRef = useRef<SessionRow | null>(selected)
  rowRef.current = selected

  useEffect(() => {
    const current = rowRef.current
    if (!current || !root) {
      setState({ status: 'idle' })
      return
    }
    let alive = true
    setState({ status: 'loading', row: current })
    void api
      .fetchSessionText(root, current.id)
      .then((text) => {
        if (alive) setState({ status: 'ready', row: current, text })
      })
      .catch((failure: unknown) => {
        if (!alive) return
        setState({ status: 'error', row: current, message: errorText(failure) })
      })
    return () => {
      alive = false
    }
  }, [root, selectedId, revision, activity, api])

  const parsed = useMemo(() => {
    if (state.status !== 'ready') return null
    try {
      return { ok: true as const, value: parsePiJsonl(state.text) }
    } catch (failure) {
      return { ok: false as const, message: errorText(failure) }
    }
  }, [state])

  const reload = useCallback(() => setRevision((current) => current + 1), [])

  /**
   * 选目录面板盖在工作区上而不是侧边栏里：目录树与绝对路径需要宽度，
   * 面板仍是模块自己的 DOM（绝对定位，不用全局 fixed），关闭后回到轨迹。
   */
  const picker = picking ? (
    <div className="picker-backdrop">
      <RootPicker
        root={root ?? ''}
        defaultRoot={config?.defaultRoot ?? ''}
        suggestedRoots={config?.suggestedRoots ?? []}
        onPick={setRoot}
        onClose={() => setPicking(false)}
      />
    </div>
  ) : null

  if (!selected || !root) {
    return (
      <div className="pisess pisess-workspace">
        <div className="viewer-center">
          <span className="viewer-hint">
            {picking ? '选择会话目录' : '从左侧选择一条会话'}
          </span>
        </div>
        {picker}
      </div>
    )
  }

  const shown = selected

  return (
    <div className="pisess pisess-workspace">
      <header className="viewer-bar">
        <span className="viewer-title">{shown.projectName}</span>
        <code className="viewer-id" title={shown.id}>
          {shown.id}
        </code>
        <span className="viewer-meta">{sessionTitle(shown)}</span>
        <span className="viewer-meta">
          {formatBytes(shown.size)} · {formatWhen(shown.modified)} · {shown.format}
        </span>
        {parsed?.ok ? (
          <span className="viewer-meta">
            {parsed.value.stats.turns} 轮 · {parsed.value.stats.messages} 条消息 ·{' '}
            {parsed.value.stats.tools} 次工具调用
          </span>
        ) : null}
        <span className="viewer-actions">
          {canResumeInChat ? (
            <button
              type="button"
              className="viewer-action"
              disabled={resuming}
              title={resumeError ?? '在对话视图继续这条会话'}
              onClick={async () => {
                setResuming(true)
                setResumeError(null)
                try {
                  await resumeInChat()
                } catch (failure) {
                  setResumeError(errorText(failure))
                } finally {
                  setResuming(false)
                }
              }}
            >
              {resuming ? '接续中…' : '在对话里继续'}
            </button>
          ) : null}
          <button type="button" className="rail-toggle" title="重新读取会话" onClick={reload}>
            <RefreshIcon />
          </button>
          <a
            className="viewer-source"
            href={api.sessionTextUrl(root, shown.id)}
            target="_blank"
            rel="noreferrer"
          >
            Raw JSONL ↗
          </a>
        </span>
      </header>

      {parsed?.ok ? <Legend /> : null}

      <main className="viewer-main">
        {state.status === 'loading' ? (
          <div className="viewer-center">
            <span className="viewer-hint">读取会话…</span>
            {shown.size > 8 * 1024 * 1024 ? (
              <span className="viewer-hint">{formatBytes(shown.size)} 会话，解析需要几秒</span>
            ) : null}
          </div>
        ) : null}

        {state.status === 'error' ? (
          <div className="viewer-center">
            <span className="viewer-error">{state.message}</span>
            <span className="viewer-hint">可用右上角的 Raw JSONL 检查原始内容。</span>
          </div>
        ) : null}

        {parsed && !parsed.ok ? (
          <div className="viewer-center">
            <span className="viewer-error">解析失败：{parsed.message}</span>
            <span className="viewer-hint">可用右上角的 Raw JSONL 检查原始内容。</span>
          </div>
        ) : null}

        {parsed?.ok ? (
          <TrajectoryViewer
            turns={parsed.value.turns}
            rows={parsed.value.rows}
            diagnostics={parsed.value.diagnostics}
            sessionRevision={shown.modified}
          />
        ) : null}
      </main>
      {picker}
    </div>
  )
}
