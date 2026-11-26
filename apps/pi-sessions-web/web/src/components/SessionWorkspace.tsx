import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parsePiJsonl, TrajectoryViewer } from 'pi-agent-trajectory-viewer'
import { fetchSessionText, sessionTextUrl, type SessionRow } from '@/api'
import { formatBytes, formatWhen, sessionTitle } from '@/lib/format'
import { RefreshIcon } from './Icons'

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

interface SessionWorkspaceProps {
  root: string
  row: SessionRow | null
}

/** 工作区：会话头部一行元信息 + 轨迹视图。渲染交给组件库，这里只做加载与状态。 */
export function SessionWorkspace({ root, row }: SessionWorkspaceProps) {
  const [state, setState] = useState<LoadState>({ status: 'idle' })
  const [revision, setRevision] = useState(0)

  const selectedId = row?.id ?? null
  // 列表轮询会持续给出新的行对象，正文只按会话 id 与手动刷新重读，不跟着列表对象走。
  const rowRef = useRef<SessionRow | null>(row)
  rowRef.current = row

  useEffect(() => {
    const current = rowRef.current
    if (!current) {
      setState({ status: 'idle' })
      return
    }
    let alive = true
    setState({ status: 'loading', row: current })
    void fetchSessionText(root, current.id)
      .then((text) => {
        if (alive) setState({ status: 'ready', row: current, text })
      })
      .catch((failure: unknown) => {
        if (!alive) return
        setState({
          status: 'error',
          row: current,
          message: failure instanceof Error ? failure.message : String(failure),
        })
      })
    return () => {
      alive = false
    }
  }, [root, selectedId, revision])

  const parsed = useMemo(() => {
    if (state.status !== 'ready') return null
    try {
      return { ok: true as const, value: parsePiJsonl(state.text) }
    } catch (failure) {
      return { ok: false as const, message: failure instanceof Error ? failure.message : String(failure) }
    }
  }, [state])

  const reload = useCallback(() => setRevision((current) => current + 1), [])

  if (!row) {
    return (
      <div className="session-workspace">
        <div className="viewer-center">
          <span className="viewer-hint">从左侧选择一条会话</span>
        </div>
      </div>
    )
  }

  const shown = row

  return (
    <div className="session-workspace">
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
          <button type="button" className="rail-toggle" title="重新读取会话" onClick={reload}>
            <RefreshIcon />
          </button>
          <a
            className="viewer-source"
            href={sessionTextUrl(root, shown.id)}
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
    </div>
  )
}
