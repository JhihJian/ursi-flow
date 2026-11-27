import { useEffect, useMemo, useRef, useState } from 'react'
import { parsePiJsonl, TrajectoryViewer } from 'pi-agent-trajectory-viewer'
import { useChatController } from './views/chat/chat-context'
import { usePiNav } from './pi-nav'
import { errorText, useSessionsController } from './views/sessions/sessions-context'
import { formatBytes, formatWhen, sessionTitle } from './views/sessions/lib/format'
import { Composer, type ComposerHandle } from './composer'
import { RefreshIcon } from './views/sessions/components/Icons'

type ReadOnly =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; turns: ReturnType<typeof parsePiJsonl> }
  | { status: 'error'; message: string }

/**
 * 会话页：一条会话的轨迹与输入框。只读轨迹与续聊是同一页面的两种模式：
 * 没装配运行时时从磁盘读文件，装配后改用事件流里的权威 transcript，两者是同一份数据。
 */

type Parsed = { ok: true; value: ReturnType<typeof parsePiJsonl> } | { ok: false; message: string }

/** 库没带类型声明，rows 就是 JSONL 行；这里只认用户消息行的最小结构。 */
interface UserRow {
  type?: string
  message?: { role?: string; content?: unknown }
}

/** 轨迹里第一条用户消息的文本，截到与列表行同一长度。 */
function firstUserText(parsed: Parsed | null): string | null {
  if (!parsed?.ok) return null
  const first = (parsed.value.rows as UserRow[]).find((row) => {
    if (row.type !== 'message' || row.message?.role !== 'user') return false
    return typeof userText(row.message.content) === 'string'
  })
  const text = first ? userText(first.message!.content) : null
  if (!text) return null
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 80).trimEnd()}…` : flat
}

/** 用户消息正文是字符串或内容块数组，块数组只取文本块。 */
function userText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const text = content
    .filter((block): block is { type: string; text: string } => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join(' ')
  return text || null
}

export function SessionThread({ sessionFile }: { sessionFile: string }) {
  const { setCwd } = usePiNav()
  const { root, listing, api } = useSessionsController()
  const chat = useChatController()
  const live = chat.active?.sessionFile === sessionFile

  const row = useMemo(
    () => listing?.sessions.find((item) => item.path === sessionFile) ?? null,
    [listing, sessionFile],
  )
  // 会话的 cwd 就是新对话的默认目录：从这条会话点「新对话」时不用再选。
  useEffect(() => {
    if (row) setCwd(row.cwd)
  }, [row, setCwd])

  const [readOnly, setReadOnly] = useState<ReadOnly>({ status: 'idle' })
  const [revision, setRevision] = useState(0)
  const lastEntries = useRef<string>('')

  // 只读加载：没装配运行时、列表里有这条会话时才读文件；装配后不再触发。
  useEffect(() => {
    if (live || !row || !root) {
      setReadOnly({ status: 'idle' })
      return
    }
    let alive = true
    setReadOnly({ status: 'loading' })
    void api
      .fetchSessionText(root, row.id)
      .then((text) => {
        if (!alive) return
        try {
          setReadOnly({ status: 'ready', turns: parsePiJsonl(text) })
        } catch (failure) {
          setReadOnly({ status: 'error', message: errorText(failure) })
        }
      })
      .catch((failure: unknown) => {
        if (alive) setReadOnly({ status: 'error', message: errorText(failure) })
      })
    return () => {
      alive = false
    }
  }, [live, row, root, api, revision])

  // 轨迹来源：装配后优先用事件流里的 transcript，首帧到达前继续显示只读内容。
  const parsed = useMemo(() => {
    if (live && chat.transcript.trim()) {
      try {
        return { ok: true as const, value: parsePiJsonl(chat.transcript) }
      } catch (failure) {
        return { ok: false as const, message: errorText(failure) }
      }
    }
    if (readOnly.status === 'ready') return { ok: true as const, value: readOnly.turns }
    if (readOnly.status === 'error') return { ok: false as const, message: readOnly.message }
    return null
  }, [live, chat.transcript, readOnly])

  // 本地修订号：轨迹内容变一次加一，只读与流式同一套值域。
  const fingerprint = live && chat.transcript ? chat.transcript : JSON.stringify(parsed?.ok ? parsed.value.stats : null)
  useEffect(() => {
    if (lastEntries.current === fingerprint) return
    lastEntries.current = fingerprint
    setRevision((current) => current + 1)
  }, [fingerprint])

  const bodyRef = useRef<HTMLDivElement | null>(null)
  // 新内容到达时贴住底部；用户往上翻时不打扰。
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 240
    if (nearBottom) body.scrollTop = body.scrollHeight
  }, [chat.transcript, chat.partial, chat.thinking, chat.runningTools.length])

  const {
    error,
    clearError,
    connectionLost,
    retry,
    compacting,
    optionsError,
    notice,
    clearNotice,
    uiRequests,
    answer,
    abort,
    close,
    resume,
    streaming,
  } = chat

  const reload = () => setRevision((current) => current + 1)

  async function stop() {
    const recalled = await abort()
    if (!recalled) return
    composerRef.current?.putBack(recalled)
  }

  const composerRef = useRef<ComposerHandle | null>(null)

  async function end() {
    await close()
  }

  // 标题：列表行有首条消息可退；刚建的对话还没落盘，从流式 transcript 里取首条用户消息。
  const title = row ? sessionTitle(row) : chat.active?.name ?? firstUserText(parsed) ?? chat.active?.sessionId.slice(0, 12) ?? ''
  const cwd = row?.cwd ?? chat.active?.cwd ?? ''
  const stats = parsed?.ok ? parsed.value.stats : null

  return (
    <div className="pichat pichat-workspace">
      <header className="pichat-bar">
        <span className="pichat-bar-title">{title}</span>
        <span className="pichat-bar-meta" title={cwd}>
          {cwd}
        </span>
        {live && chat.active ? (
          <span className={`pichat-bar-meta pichat-state is-${chat.active.state}`}>
            {chat.active.state === 'running' ? '运行中' : chat.active.state === 'error' ? '出错' : '空闲'}
          </span>
        ) : null}
        <span className="pichat-bar-actions">
          {streaming ? (
            <button type="button" className="pichat-button is-sm" onClick={() => void stop()}>
              停止
            </button>
          ) : null}
          {!live ? (
            <button type="button" className="rail-toggle" title="重新读取会话" onClick={reload}>
              <RefreshIcon />
            </button>
          ) : null}
          <button type="button" className="pichat-button is-sm" onClick={() => void end()}>
            结束
          </button>
        </span>
      </header>

      {error ? (
        <div className="pichat-banner is-error" onClick={clearError} title="点击关闭">
          {error}
        </div>
      ) : null}
      {connectionLost ? (
        <div className="pichat-banner">
          <span>事件流断开，正在重连；重连后会补回这段输出。</span>
        </div>
      ) : null}
      {retry ? (
        <div className="pichat-banner">
          <span>
            正在重试（{retry.attempt}/{retry.maxAttempts}）：{retry.message}
          </span>
        </div>
      ) : null}
      {compacting ? <div className="pichat-banner">正在压缩上下文…</div> : null}
      {optionsError ? <div className="pichat-banner is-error">{optionsError}</div> : null}
      {notice ? (
        <div className="pichat-banner">
          <span>{notice.message}</span>
          <button type="button" className="pichat-link" onClick={clearNotice}>
            知道了
          </button>
        </div>
      ) : null}

      <div className="pichat-thread" ref={bodyRef}>
        {parsed?.ok ? (
          <TrajectoryViewer
            turns={parsed.value.turns}
            rows={parsed.value.rows}
            diagnostics={parsed.value.diagnostics}
            sessionRevision={revision}
          />
        ) : parsed && !parsed.ok ? (
          <div className="pichat-center">
            <p className="pichat-error">解析会话内容失败：{parsed.message}</p>
          </div>
        ) : readOnly.status === 'loading' ? (
          <div className="pichat-center">
            <p>读取会话…</p>
          </div>
        ) : readOnly.status === 'error' ? (
          <div className="pichat-center">
            <p className="pichat-error">{readOnly.message}</p>
          </div>
        ) : (
          <div className="pichat-center">
            <p>{live ? '发一条消息开始这段对话。' : '在下面发消息就在这条会话里继续。'}</p>
            {row ? (
              <p className="pichat-hint">
                {formatBytes(row.size)} · {formatWhen(row.modified)}
                {stats ? ` · ${stats.turns} 轮 · ${stats.messages} 条消息 · ${stats.tools} 次工具调用` : ''}
              </p>
            ) : null}
          </div>
        )}

        {chat.thinking ? (
          <div className="pichat-streaming is-thinking">
            <div className="pichat-streaming-head">
              <span className="pichat-streaming-tag">思考</span>
            </div>
            <pre className="pichat-streaming-body">{chat.thinking}</pre>
          </div>
        ) : null}

        {chat.partial ? (
          <div className="pichat-streaming">
            <div className="pichat-streaming-head">
              <span className="pichat-streaming-tag">正在输出</span>
              <span>{chat.active?.model ?? '默认模型'}</span>
            </div>
            <pre className="pichat-streaming-body">{chat.partial}</pre>
          </div>
        ) : null}

        {chat.runningTools.length > 0 ? (
          <ul className="pichat-tools">
            {chat.runningTools.map((tool) => (
              <li key={tool.id} className="pichat-tool">
                <span className="pichat-tool-name">{tool.name}</span>
                <span className="pichat-hint">正在执行…</span>
              </li>
            ))}
          </ul>
        ) : null}

        {chat.pending > 0 ? <div className="pichat-pending">排队中：{chat.pending} 条</div> : null}
      </div>

      {live && uiRequests[0] ? <UiRequestPanel uiRequests={uiRequests} answer={answer} /> : null}

      <Composer
        ref={composerRef}
        key={sessionFile}
        mode={live ? 'session' : 'draft'}
        beforeSubmit={async () => {
          if (live) return { ok: true }
          const resumed = await resume(sessionFile)
          return resumed ? { ok: true } : { ok: false, message: '装配运行时失败' }
        }}
      />
    </div>
  )
}

const UI_KIND_TEXT: Record<string, string> = { confirm: '需要确认', select: '请选择', input: '请填写' }

function UiRequestPanel({
  uiRequests,
  answer,
}: {
  uiRequests: ReturnType<typeof useChatController>['uiRequests']
  answer: ReturnType<typeof useChatController>['answer']
}) {
  const uiRequest = uiRequests[0]
  return (
    <div className="pichat-ui-request">
      <div className="pichat-ui-request-head">
        {UI_KIND_TEXT[uiRequest.kind] ?? '请处理'}
        <span className="pichat-label">{uiRequest.title}</span>
        {uiRequests.length > 1 ? <span className="pichat-count">还有 {uiRequests.length - 1} 个</span> : null}
      </div>
      {uiRequest.message ? <p className="pichat-ui-request-msg">{uiRequest.message}</p> : null}
      {uiRequest.kind === 'confirm' ? (
        <div className="pichat-ui-request-actions">
          <button
            type="button"
            className="pichat-button is-sm is-primary"
            onClick={() => void answer(uiRequest.requestId, true)}
          >
            同意
          </button>
          <button type="button" className="pichat-button is-sm" onClick={() => void answer(uiRequest.requestId, false)}>
            拒绝
          </button>
        </div>
      ) : null}
      {uiRequest.kind === 'select' ? (
        <div className="pichat-ui-request-actions">
          {(uiRequest.options ?? []).map((option) => (
            <button
              key={option}
              type="button"
              className="pichat-button is-sm"
              onClick={() => void answer(uiRequest.requestId, option)}
            >
              {option}
            </button>
          ))}
          <button type="button" className="pichat-link" onClick={() => void answer(uiRequest.requestId, undefined)}>
            取消
          </button>
        </div>
      ) : null}
      {uiRequest.kind === 'input' ? (
        <form
          className="pichat-ui-request-actions"
          onSubmit={(event) => {
            event.preventDefault()
            const value = new FormData(event.currentTarget).get('value')
            void answer(uiRequest.requestId, typeof value === 'string' ? value : '')
          }}
        >
          <input name="value" className="pichat-input" placeholder={uiRequest.placeholder ?? ''} autoFocus />
          <button type="submit" className="pichat-button is-sm is-primary">
            提交
          </button>
        </form>
      ) : null}
    </div>
  )
}
