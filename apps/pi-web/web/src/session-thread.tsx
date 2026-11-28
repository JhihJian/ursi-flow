import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parsePiJsonl, TrajectoryViewer } from 'pi-agent-trajectory-viewer'
import { useChatController } from './views/chat/chat-context'
import { usePi } from './pi-context'
import { usePiNav } from './pi-nav'
import { errorText, useSessionsController } from './views/sessions/sessions-context'
import { formatBytes, formatWhen, sessionTitle } from './views/sessions/lib/format'
import { Composer, type ComposerHandle } from './composer'
import { RefreshIcon } from './views/sessions/components/Icons'

type ReadOnly =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; turns: ReturnType<typeof parsePiJsonl>; forId: string }
  | { status: 'error'; message: string }

/**
 * 会话页：应用里唯一的工作区页面（配置页除外）。`sessionId` 为空是空会话页，
 * 发首条消息才建会话，建完原地填上 id，不换页、不重挂输入框。
 *
 * 只读轨迹与续聊是同一页面的两种模式：没装配运行时时从磁盘读文件，
 * 装配后改用事件流里的权威 transcript，两者是同一份数据。
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

export function SessionThread({ sessionId }: { sessionId: string | null }) {
  const { cwd: navCwd, setCwd } = usePiNav()
  const { home } = usePi()
  const { root, listing, api } = useSessionsController()
  const chat = useChatController()
  // 页面指向的会话已经装配：事件流里的 transcript 就是权威。
  const live = sessionId !== null && chat.active?.sessionId === sessionId

  const row = useMemo(
    () => (sessionId === null ? null : (listing?.sessions.find((item) => item.id === sessionId) ?? null)),
    [listing, sessionId],
  )
  // 会话的 cwd 就是空会话页的默认目录：从这条会话点「+ 新对话」时不用再选。
  useEffect(() => {
    if (row) setCwd(row.cwd)
  }, [row, setCwd])

  const [readOnly, setReadOnly] = useState<ReadOnly>({ status: 'idle' })
  const [revision, setRevision] = useState(0)
  const lastEntries = useRef<string>('')
  // 加载序号：只有最新一次加载可以写结果，effect 重跑与手动重读的竞态都靠它收敛。
  const loadSeq = useRef(0)
  // 只依赖会话路径：列表轮询会换 row 对象引用，跟着重拉没有意义。
  const rowId = row?.id

  // 只读加载：没装配运行时、列表里有这条会话时才读文件；装配后不再触发。空会话页没有文件。
  const loadReadOnly = useCallback(() => {
    if (live || !rowId || !root) {
      setReadOnly({ status: 'idle' })
      return
    }
    const seq = ++loadSeq.current
    setReadOnly({ status: 'loading' })
    void api
      .fetchSessionText(root, rowId)
      .then((text) => {
        if (seq !== loadSeq.current) return
        try {
          setReadOnly({ status: 'ready', turns: parsePiJsonl(text), forId: rowId })
        } catch (failure) {
          setReadOnly({ status: 'error', message: errorText(failure) })
        }
      })
      .catch((failure: unknown) => {
        if (seq === loadSeq.current) setReadOnly({ status: 'error', message: errorText(failure) })
      })
  }, [live, rowId, root, api])

  // 数据来源变化时装载。手动「重新读取」直接再调一次，不经过渲染循环：
  // 曾经把 revision 放进这里的依赖，而 revision 又由加载结果递增，
  // loading 态把 fingerprint 打回 null 会再次递增，形成每秒十几次的重拉循环。
  useEffect(() => {
    loadReadOnly()
  }, [loadReadOnly])

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
  // 只在已就绪的内容上比较：loading/error 不参与，否则加载本身会推动修订号，
  // 修订号又驱动加载，转回上面的重拉循环。
  const fingerprint = live && chat.transcript ? chat.transcript : parsed?.ok ? JSON.stringify(parsed.value.stats) : ''
  useEffect(() => {
    if (!fingerprint || lastEntries.current === fingerprint) return
    lastEntries.current = fingerprint
    setRevision((current) => current + 1)
  }, [fingerprint])

  const bodyRef = useRef<HTMLDivElement | null>(null)
  // 轨迹的真实滚动窗格在组件库内部：阅读/执行视图是 .view-pane，记录表是 .record-list；
  // 外层 .pichat-thread 只在流式回执撑高时才滚。找不到内部窗格就退回外层容器。
  const scrollPaneOf = useCallback((): HTMLElement | null => {
    const body = bodyRef.current
    if (!body) return null
    return body.querySelector<HTMLElement>('.view-pane, .record-list') ?? body
  }, [])

  /** 外层容器与内部窗格都推到底部：用户在哪个窗格上滚动都能落在最新消息。 */
  const scrollToBottom = useCallback(() => {
    const body = bodyRef.current
    const pane = scrollPaneOf()
    if (pane && pane !== body) pane.scrollTop = pane.scrollHeight
    if (body) body.scrollTop = body.scrollHeight
  }, [scrollPaneOf])

  /** 是否停在底部附近：外层与内部窗格任一在底部即算。 */
  const nearBottom = useCallback(() => {
    const body = bodyRef.current
    if (!body) return true
    const close = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 240
    const pane = scrollPaneOf()
    return pane !== null && close(pane)
  }, [scrollPaneOf])

  // 进入（或回到）一条会话先定位到最新消息：pendingJump 只消费一次，
  // 等这条会话的内容真的排出（revision 推进且内容属于当前会话）再跳，
  // 之后的输出交给贴底逻辑。组件不按会话重挂，这个标记按 sessionId 重置。
  const pendingJumpRef = useRef(true)
  useEffect(() => {
    pendingJumpRef.current = true
  }, [sessionId])
  const loadedForId = readOnly.status === 'ready' ? readOnly.forId : live ? sessionId : null
  useEffect(() => {
    if (!pendingJumpRef.current || !parsed?.ok || loadedForId === null) return
    const frame = requestAnimationFrame(() => {
      pendingJumpRef.current = false
      scrollToBottom()
      // 阅读视图按内容测量布局，下一帧再校准一次。
      requestAnimationFrame(() => {
        if (!pendingJumpRef.current) scrollToBottom()
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [revision, parsed?.ok, loadedForId, scrollToBottom])

  // 用户是否停在底部附近只在滚动时记录：新内容到达时此刻的判断才可靠。
  const wasNearBottomRef = useRef(true)
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const record = () => {
      wasNearBottomRef.current = nearBottom()
    }
    // 视图切换会换掉内部窗格，跟着 revision 重挂一次监听。
    const pane = scrollPaneOf()
    body.addEventListener('scroll', record, { passive: true })
    pane?.addEventListener('scroll', record, { passive: true })
    return () => {
      body.removeEventListener('scroll', record)
      pane?.removeEventListener('scroll', record)
    }
  }, [nearBottom, scrollPaneOf, revision, chat.transcript])

  // 新内容到达时贴住底部；用户往上翻时不打扰。
  useEffect(() => {
    if (!wasNearBottomRef.current) return
    scrollToBottom()
  }, [revision, chat.transcript, chat.partial, chat.thinking, chat.runningTools.length, scrollToBottom])

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
    streaming,
  } = chat

  const reload = useCallback(() => loadReadOnly(), [loadReadOnly])

  async function stop() {
    const recalled = await abort()
    if (!recalled) return
    composerRef.current?.putBack(recalled)
  }

  const composerRef = useRef<ComposerHandle | null>(null)

  // 标题：列表行有首条消息可退；刚建的对话还没落盘，从流式 transcript 里取首条用户消息。
  const title = row
    ? sessionTitle(row)
    : chat.active?.name ?? firstUserText(parsed) ?? (sessionId ? chat.active?.sessionId.slice(0, 12) ?? '会话' : '新对话')
  const cwd = row?.cwd ?? chat.active?.cwd ?? (sessionId ? '' : (navCwd ?? ''))
  const stats = parsed?.ok ? parsed.value.stats : null

  return (
    <div className="pichat pichat-workspace">
      <header className="pichat-bar">
        <span className="pichat-bar-title">{title}</span>
        <span className="pichat-bar-meta" title={cwd}>
          {sessionId === null && !cwd
            ? home
              ? `${home.name} · 点左侧一个目录`
              : '未选 pi home'
            : cwd}
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
          {sessionId !== null && !live ? (
            <button type="button" className="rail-toggle" title="重新读取会话" onClick={reload}>
              <RefreshIcon />
            </button>
          ) : null}
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
            {sessionId === null ? (
              <>
                <p>{cwd ? `工作目录 ${cwd}` : '在左侧点一个目录，或者点一条会话。'}</p>
                <p className="pichat-hint">模型与思考级别在输入框下方选择，发出第一条消息即建会话。</p>
              </>
            ) : (
              <>
                <p>{live ? '发一条消息开始这段对话。' : '在下面发消息就在这条会话里继续。'}</p>
                {row ? (
                  <p className="pichat-hint">
                    {formatBytes(row.size)} · {formatWhen(row.modified)}
                    {stats ? ` · ${stats.turns} 轮 · ${stats.messages} 条消息 · ${stats.tools} 次工具调用` : ''}
                  </p>
                ) : null}
              </>
            )}
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

      {/* 不按会话建键：从空会话页到建完对话，输入框是同一个，用户正在打的字不丢。 */}
      <Composer ref={composerRef} sessionId={sessionId} />
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
