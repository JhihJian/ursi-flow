import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  createApiClient,
  type ApiError,
  type ChatInfo,
  type ChatModelOption,
  type ChatOptions,
  type HomeSummary,
} from '@ursi/pi-manager-web/client'

/**
 * 对话模块的共享状态。
 *
 * 数据来自管理台的运行时：本模块不加载 SDK、不读写配置、不碰会话文件。
 * 侧边栏与工作区在 DOM 上是两块，因此这里只放纯状态，不渲染布局。
 *
 * 「建立一次对话」沿用 pi-web 的顺序：先在编辑器里选好 home / 工作目录 / 模型 /
 * 思考级别，发出第一条消息时才向管理台建会话，建完立刻接上事件流。没有单独的
 * 「新建空对话」动作，因此也不会留下没有消息的会话文件。
 */

export interface Notice {
  kind: 'info' | 'error'
  message: string
}

export interface UiRequest {
  requestId: string
  kind: 'confirm' | 'select' | 'input'
  title: string
  message?: string
  options?: string[]
  placeholder?: string
  timeoutMs: number
  expiresAt: number
}

export interface ChatDraft {
  /** 具体模型 `provider/modelId`；空串表示用该 home 的默认模型。 */
  model: string
  thinkingLevel: string
  cwd: string
  subagent: string
}

export interface RunningTool {
  id: string
  name: string
  startedAt: number
}

export interface RetryInfo {
  attempt: number
  maxAttempts: number
  message: string
}

export interface ChatControllerOptions {
  /** 管理台接口前缀，由宿主注入；独立入口传空串（同源）。 */
  managerApiBaseUrl?: string
  /** localStorage 键前缀，避免同一浏览器里两个实例互相覆盖。 */
  storageKey?: string
  /** 跳到会话模块看完整轨迹；未注入时不显示该入口。 */
  openSessionInSessions?: (target: {
    root: string
    sessionFile: string
    id: string
  }) => Promise<unknown>
  /** 需要用户看见的提示（宿主可接管）。 */
  onNotice?: (notice: Notice) => void
}

export interface SubmitResult {
  ok: boolean
  message?: string
}

export interface ChatController {
  api: ReturnType<typeof createApiClient>
  homes: HomeSummary[]
  home: string
  setHome: (home: string) => void
  options: ChatOptions | null
  optionsError: string | null
  refreshOptions: () => Promise<void>

  chats: ChatInfo[]
  active: ChatInfo | null
  activeId: string | null
  selectChat: (sessionId: string | null) => void
  startNewChat: () => void

  transcript: string
  partial: string
  thinking: string
  streaming: boolean
  pending: number
  runningTools: RunningTool[]
  retry: RetryInfo | null
  compacting: boolean
  connectionLost: boolean
  error: string | null
  notice: Notice | null
  clearNotice: () => void
  uiRequests: UiRequest[]

  draft: ChatDraft
  setDraft: (patch: Partial<ChatDraft>) => void
  /** 新对话当前会用的模型；draft 没选时取该 home 的默认值。 */
  draftModel: ChatModelOption | null
  /** 新对话当前会用的思考档位（总会落到一个该模型支持的档位）。 */
  draftThinkingLevel: string
  /** 当前对话的模型信息；会话里的模型不在候选范围时也能显示。 */
  activeModel: ChatModelOption | null
  sending: boolean

  submit: (text: string, mode?: 'steer' | 'followUp') => Promise<SubmitResult>
  /** 从历史会话文件续聊（跨模块命令用）；home 由管理台按文件反查。 */
  resume: (sessionFile: string) => Promise<ChatInfo | null>
  abort: () => Promise<string>
  switchModel: (provider: string, modelId: string, thinkingLevel?: string) => Promise<void>
  setThinkingLevel: (level: string) => Promise<void>
  answer: (requestId: string, value: unknown) => Promise<void>
  close: () => Promise<void>
  openTrajectory: () => Promise<void>
  canOpenTrajectory: boolean
}

const EMPTY_DRAFT: ChatDraft = { model: '', thinkingLevel: '', cwd: '', subagent: '' }

/** 模型不支持思考时唯一可用的档位。 */
const NO_THINKING = 'off'

const ChatContext = createContext<ChatController | null>(null)

export function ChatProvider({
  options,
  children,
}: {
  options: ChatControllerOptions
  children: ReactNode
}) {
  const api = useMemo(
    () => createApiClient(options.managerApiBaseUrl ?? ''),
    [options.managerApiBaseUrl],
  )
  const storageKey = options.storageKey ?? 'pi-chat'
  const homeKey = `${storageKey}:home`
  const lastChatKey = `${storageKey}:last-chat`

  const [homes, setHomes] = useState<HomeSummary[]>([])
  const [home, setHomeState] = useState<string>(() => readLocal(homeKey))
  const [chatOptions, setChatOptions] = useState<ChatOptions | null>(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)

  const [chats, setChats] = useState<ChatInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  const [transcript, setTranscript] = useState('')
  const [partial, setPartial] = useState('')
  const [thinking, setThinking] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [pending, setPending] = useState(0)
  const [runningTools, setRunningTools] = useState<RunningTool[]>([])
  const [retry, setRetry] = useState<RetryInfo | null>(null)
  const [compacting, setCompacting] = useState(false)
  const [connectionLost, setConnectionLost] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [uiRequests, setUiRequests] = useState<UiRequest[]>([])

  const [draft, setDraftState] = useState<ChatDraft>(EMPTY_DRAFT)
  const [sending, setSending] = useState(false)

  // 事件流是否已经握上手：首条消息要等它，否则 session_start 的扩展对话框
  // 可能在没有人订阅的时候发出。
  const streamReadyRef = useRef<Set<string>>(new Set())

  const notify = useCallback(
    (next: Notice) => {
      if (options.onNotice) options.onNotice(next)
      else setNotice(next)
    },
    [options.onNotice],
  )

  const active = chats.find((chat) => chat.sessionId === activeId) ?? null
  const activeModel = useMemo(
    () => (active ? modelOptionFor(chatOptions, active.model) : null),
    [active, chatOptions],
  )

  const patchChat = useCallback((sessionId: string, patch: Partial<ChatInfo>) => {
    setChats((current) =>
      current.map((chat) => (chat.sessionId === sessionId ? { ...chat, ...patch } : chat)),
    )
  }, [])

  // 轮询是异步的：刚建好的对话可能在某个早已发出的列表请求里还没有，
  // 因此合并时保留当前选中的那一条，不让它被旧响应冲掉。
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId

  // ---- home 与可选项 -------------------------------------------------------

  useEffect(() => {
    let alive = true
    void api
      .getHomes()
      .then((listing) => {
        if (!alive) return
        setHomes(listing.homes)
        const valid = listing.homes.filter((entry) => entry.valid)
        setHomeState((current) => {
          if (current && valid.some((entry) => entry.path === current)) return current
          const fallback = valid[0]?.path ?? ''
          if (fallback) writeLocal(homeKey, fallback)
          return fallback
        })
      })
      .catch((failure: unknown) => {
        if (alive) setOptionsError(errorText(failure))
      })
    return () => {
      alive = false
    }
  }, [api, homeKey])

  const refreshOptions = useCallback(async () => {
    if (!home) {
      setChatOptions(null)
      return
    }
    try {
      const next = await api.getChatOptions(home)
      setChatOptions(next)
      setOptionsError(null)
      setDraftState((current) => {
        const model = pickModel(next, current.model)
        return {
          ...current,
          cwd: current.cwd || next.defaultCwd,
          model,
          thinkingLevel: pickThinking(next, model, current.thinkingLevel),
        }
      })
    } catch (failure) {
      setOptionsError(errorText(failure))
      setChatOptions(null)
    }
  }, [api, home])

  useEffect(() => {
    void refreshOptions()
  }, [refreshOptions])

  /** 用户切 home：当前对话不属于新 home，一律清掉。 */
  const setHome = useCallback(
    (path: string) => {
      setActiveId(null)
      setTranscript('')
      setPartial('')
      setThinking('')
      setPending(0)
      setRunningTools([])
      setUiRequests([])
      setError(null)
      setDraftState(EMPTY_DRAFT)
      writeLocal(homeKey, path)
      setHomeState(path)
    },
    [homeKey],
  )

  // ---- 对话列表 -----------------------------------------------------------

  const refreshChats = useCallback(async () => {
    if (!home) {
      setChats([])
      return
    }
    try {
      const listing = await api.listChats(home)
      setChats((current) => {
        const known = new Set(listing.chats.map((chat) => chat.sessionId))
        const keep = current.filter(
          (chat) => !known.has(chat.sessionId) && chat.sessionId === activeIdRef.current,
        )
        return [...listing.chats, ...keep]
      })
    } catch {
      /* 列表失败不清空已有内容 */
    }
  }, [api, home])

  useEffect(() => {
    if (!home) {
      setChats([])
      return
    }
    void refreshChats()
    const timer = setInterval(() => void refreshChats(), 10_000)
    return () => clearInterval(timer)
  }, [home, refreshChats])

  const setDraft = useCallback((patch: Partial<ChatDraft>) => {
    setDraftState((current) => ({ ...current, ...patch }))
  }, [])

  const startNewChat = useCallback(() => {
    setActiveId(null)
    setTranscript('')
    setPartial('')
    setThinking('')
    setStreaming(false)
    setPending(0)
    setRunningTools([])
    setUiRequests([])
    setError(null)
    setRetry(null)
    setCompacting(false)
    setConnectionLost(false)
  }, [])

  const selectChat = useCallback((sessionId: string | null) => {
    setActiveId(sessionId)
    setTranscript('')
    setPartial('')
    setThinking('')
    setStreaming(false)
    setPending(0)
    setRunningTools([])
    setUiRequests([])
    setError(null)
    setRetry(null)
    setCompacting(false)
    setConnectionLost(false)
  }, [])

  // ---- 事件流 -------------------------------------------------------------

  useEffect(() => {
    if (!activeId) return
    let alive = true
    setPartial('')
    setThinking('')
    setStreaming(false)
    setRetry(null)
    setCompacting(false)
    let goneCheck: number | undefined
    const source = new EventSource(api.chatStreamUrl(activeId))

    source.onmessage = (event) => {
      if (!alive) return
      streamReadyRef.current.add(activeId)
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(event.data) as Record<string, unknown>
      } catch {
        return
      }
      setConnectionLost(false)
      switch (frame.type) {
        case 'transcript':
          setTranscript(typeof frame.jsonl === 'string' ? frame.jsonl : '')
          break
        case 'state':
          setStreaming(frame.isStreaming === true)
          setPartial(typeof frame.partial === 'string' ? frame.partial : '')
          setThinking(typeof frame.partialThinking === 'string' ? frame.partialThinking : '')
          setPending(typeof frame.pendingCount === 'number' ? frame.pendingCount : 0)
          // 状态帧就是服务端的权威快照：模型、思考级别、会话文件都以它为准。
          patchChat(activeId, {
            state: (frame.state as ChatInfo['state']) ?? 'idle',
            model: typeof frame.model === 'string' ? frame.model : null,
            thinkingLevel: typeof frame.thinkingLevel === 'string' ? frame.thinkingLevel : null,
            sessionFile: typeof frame.sessionFile === 'string' ? frame.sessionFile : null,
            name: typeof frame.name === 'string' ? frame.name : null,
            error: typeof frame.error === 'string' ? frame.error : null,
          })
          break
        case 'delta':
          setPartial((current) => current + (typeof frame.text === 'string' ? frame.text : ''))
          break
        case 'thinking_delta':
          setThinking((current) => current + (typeof frame.text === 'string' ? frame.text : ''))
          break
        case 'message_start':
          if (frame.role === 'assistant') {
            setPartial('')
            setThinking('')
          }
          break
        case 'message_end':
          setPartial('')
          setThinking('')
          break
        case 'agent_start':
          setStreaming(true)
          setError(null)
          setRetry(null)
          patchChat(activeId, { state: 'running', error: null })
          break
        case 'agent_settled':
          setStreaming(false)
          setPartial('')
          setThinking('')
          setPending(0)
          setRunningTools([])
          setRetry(null)
          setCompacting(false)
          patchChat(activeId, { state: 'idle' })
          break
        case 'queue_update': {
          const steering = Array.isArray(frame.steering) ? frame.steering.length : 0
          const followUp = Array.isArray(frame.followUp) ? frame.followUp.length : 0
          setPending(steering + followUp)
          break
        }
        case 'tool_execution_start': {
          const id = String(frame.toolCallId ?? '')
          const name = String(frame.toolName ?? 'tool')
          setRunningTools((current) =>
            current.some((tool) => tool.id === id)
              ? current
              : [...current, { id, name, startedAt: Date.now() }],
          )
          break
        }
        case 'tool_execution_end': {
          const id = String(frame.toolCallId ?? '')
          setRunningTools((current) => current.filter((tool) => tool.id !== id))
          break
        }
        case 'extension_ui_request': {
          const timeoutMs = typeof frame.timeoutMs === 'number' ? frame.timeoutMs : 120_000
          const request: UiRequest = {
            requestId: String(frame.requestId ?? ''),
            kind: (frame.kind as UiRequest['kind']) ?? 'confirm',
            title: String(frame.title ?? ''),
            message: typeof frame.message === 'string' ? frame.message : undefined,
            options: Array.isArray(frame.options) ? (frame.options as string[]) : undefined,
            placeholder: typeof frame.placeholder === 'string' ? frame.placeholder : undefined,
            timeoutMs,
            expiresAt: Date.now() + timeoutMs,
          }
          setUiRequests((current) =>
            current.some((item) => item.requestId === request.requestId)
              ? current
              : [...current, request],
          )
          break
        }
        case 'extension_ui_closed': {
          const requestId = String(frame.requestId ?? '')
          setUiRequests((current) => current.filter((item) => item.requestId !== requestId))
          break
        }
        case 'thinking_level_changed':
          if (typeof frame.level === 'string') patchChat(activeId, { thinkingLevel: frame.level })
          break
        case 'session_info_changed':
          patchChat(activeId, { name: typeof frame.name === 'string' ? frame.name : null })
          break
        case 'auto_retry_start':
          setRetry({
            attempt: typeof frame.attempt === 'number' ? frame.attempt : 1,
            maxAttempts: typeof frame.maxAttempts === 'number' ? frame.maxAttempts : 1,
            message: typeof frame.errorMessage === 'string' ? frame.errorMessage : '请求失败，正在重试',
          })
          break
        case 'auto_retry_end':
          setRetry(null)
          break
        case 'compaction_start':
          setCompacting(true)
          break
        case 'compaction_end':
          setCompacting(false)
          break
        case 'notify':
          notify({ kind: 'info', message: String(frame.message ?? '') })
          break
        case 'error': {
          const message = String(frame.message ?? '对话出错')
          setError(message)
          patchChat(activeId, { state: 'error', error: message })
          break
        }
        default:
          break
      }
    }
    source.onerror = () => {
      // EventSource 自己会重连；这里只把状态标出来，不让界面像卡住一样。
      if (!alive) return
      setConnectionLost(true)
      if (goneCheck !== undefined) return
      // 服务端已经释放了这场对话时，重连永远不会成功：确认一次后收尾。
      goneCheck = window.setTimeout(() => {
        goneCheck = undefined
        void api
          .getChat(activeId)
          .catch((failure: unknown) => {
            if (!alive) return
            if (failure instanceof Error && (failure as ApiError).status === 404) {
              setChats((current) => current.filter((chat) => chat.sessionId !== activeId))
              setActiveId(null)
              notify({ kind: 'error', message: '这条对话已在服务端结束' })
            }
          })
      }, 2_000)
    }
    return () => {
      alive = false
      streamReadyRef.current.delete(activeId)
      if (goneCheck !== undefined) clearTimeout(goneCheck)
      source.close()
    }
  }, [activeId, api, notify, patchChat])

  // 扩展 UI 请求的客户端过期：服务端到点也会关，但界面不必等它。
  useEffect(() => {
    if (uiRequests.length === 0) return
    const timer = setInterval(() => {
      const now = Date.now()
      setUiRequests((current) => current.filter((request) => request.expiresAt > now))
    }, 1_000)
    return () => clearInterval(timer)
  }, [uiRequests.length])

  // ---- 恢复上次打开的对话 ------------------------------------------------

  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !home) return
    restored.current = true
    const saved = readJson<{ sessionId?: string; sessionFile?: string; home?: string }>(lastChatKey)
    if (!saved) return
    const savedHome = saved.home ?? ''
    if (!savedHome) return
    writeLocal(homeKey, savedHome)
    setHomeState(savedHome)
    void (async () => {
      try {
        const listing = await api.listChats(savedHome)
        const found = saved.sessionId
          ? listing.chats.find((chat) => chat.sessionId === saved.sessionId)
          : undefined
        if (found) {
          setChats((current) => [
            found,
            ...current.filter((chat) => chat.sessionId !== found.sessionId),
          ])
          setActiveId(found.sessionId)
          return
        }
        if (saved.sessionFile) {
          const chat = await api.createChat({ sessionFile: saved.sessionFile })
          setChats((current) => [
            chat,
            ...current.filter((item) => item.sessionId !== chat.sessionId),
          ])
          setActiveId(chat.sessionId)
          if (chat.fallbackMessage) notify({ kind: 'info', message: chat.fallbackMessage })
        }
      } catch {
        /* 上次的对话接不回来时静默放弃，不拦住新对话 */
      }
    })()
  }, [api, home, homeKey, lastChatKey, notify])

  // 记住当前对话；sessionFile 在首条消息落盘后才有，列表刷新会补上。
  useEffect(() => {
    if (!active) return
    writeLocal(
      lastChatKey,
      JSON.stringify({
        sessionId: active.sessionId,
        sessionFile: active.sessionFile,
        home: active.home,
      }),
    )
  }, [active, lastChatKey])

  // ---- 建立对话与收发 -----------------------------------------------------

  const submit = useCallback(
    async (text: string, mode?: 'steer' | 'followUp'): Promise<SubmitResult> => {
      const content = text.trim()
      if (!content) return { ok: false }
      setError(null)
      setSending(true)
      try {
        let target = active
        if (!target) {
          if (!home) return { ok: false, message: '先在左侧选择一份 pi home' }
          const model = pickModel(chatOptions, draft.model)
          const thinkingLevel = pickThinking(chatOptions, model, draft.thinkingLevel)
          target = await api.createChat({
            home,
            ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
            ...(model ? { model } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
            ...(draft.subagent ? { subagent: draft.subagent } : {}),
          })
          setChats((current) => [
            target as ChatInfo,
            ...current.filter((chat) => chat.sessionId !== target?.sessionId),
          ])
          setActiveId(target.sessionId)
          setTranscript('')
          if (target.fallbackMessage) notify({ kind: 'info', message: target.fallbackMessage })
          // 先让事件流接上，再发首条消息：session_start 的确认框需要订阅者。
          await waitForStream(streamReadyRef, target.sessionId)
        }
        const streamingNow = target.isStreaming || target.state === 'running'
        await api.promptChat(
          target.sessionId,
          content,
          streamingNow ? (mode ?? 'followUp') : mode,
        )
        return { ok: true }
      } catch (failure) {
        const message = errorText(failure)
        setError(message)
        return { ok: false, message }
      } finally {
        setSending(false)
      }
    },
    [active, api, chatOptions, draft, home, notify],
  )

  const abort = useCallback(async (): Promise<string> => {
    if (!activeId) return ''
    try {
      const cleared = await api.abortChat(activeId)
      setPending(0)
      setPartial('')
      setThinking('')
      setRunningTools([])
      return [...cleared.steering, ...cleared.followUp].join('\n')
    } catch (failure) {
      setError(errorText(failure))
      return ''
    }
  }, [activeId, api])

  const switchModel = useCallback(
    async (provider: string, modelId: string, thinkingLevel?: string) => {
      if (!activeId) return
      try {
        const next = await api.setChatModel(activeId, provider, modelId, thinkingLevel)
        patchChat(next.sessionId, next)
      } catch (failure) {
        setError(errorText(failure))
      }
    },
    [activeId, api, patchChat],
  )

  const setThinkingLevel = useCallback(
    async (level: string) => {
      if (!active || !level) return
      const [provider, modelId] = splitRef(active.model ?? '')
      if (!provider || !modelId) return
      await switchModel(provider, modelId, level)
    },
    [active, switchModel],
  )

  const answer = useCallback(
    async (requestId: string, value: unknown) => {
      if (!activeId) return
      setUiRequests((current) => current.filter((item) => item.requestId !== requestId))
      try {
        await api.answerChat(activeId, requestId, value)
      } catch (failure) {
        setError(errorText(failure))
      }
    },
    [activeId, api],
  )

  const resume = useCallback(
    async (sessionFile: string): Promise<ChatInfo | null> => {
      try {
        const chat = await api.createChat({ sessionFile })
        writeLocal(homeKey, chat.home)
        setHomeState(chat.home)
        setChats((current) => [chat, ...current.filter((item) => item.sessionId !== chat.sessionId)])
        setActiveId(chat.sessionId)
        setTranscript('')
        setPartial('')
        setThinking('')
        setError(null)
        if (chat.fallbackMessage) notify({ kind: 'info', message: chat.fallbackMessage })
        return chat
      } catch (failure) {
        notify({ kind: 'error', message: errorText(failure) })
        return null
      }
    },
    [api, homeKey, notify],
  )

  const close = useCallback(async () => {
    if (!activeId) return
    const id = activeId
    try {
      await api.closeChat(id)
    } catch {
      /* 关闭失败也把本地状态清掉 */
    }
    setChats((current) => current.filter((item) => item.sessionId !== id))
    setActiveId(null)
    setStreaming(false)
    setPartial('')
    setThinking('')
    setRunningTools([])
    setPending(0)
    setUiRequests([])
    void refreshChats()
  }, [activeId, api, refreshChats])

  const openTrajectory = useCallback(async () => {
    if (!active?.sessionFile) {
      notify({ kind: 'error', message: '这条路对话还没有会话文件' })
      return
    }
    if (!options.openSessionInSessions) {
      notify({ kind: 'error', message: '会话模块未启用' })
      return
    }
    try {
      const disk = await api.getSessionDisk(active.home)
      await options.openSessionInSessions({
        root: disk.root,
        sessionFile: active.sessionFile,
        id: active.sessionId,
      })
    } catch (failure) {
      notify({ kind: 'error', message: errorText(failure) })
    }
  }, [active, api, notify, options])

  // ---- 新对话的模型与思考级别 ---------------------------------------------

  const draftModel = useMemo(
    () => pickModelOption(chatOptions, pickModel(chatOptions, draft.model)),
    [chatOptions, draft.model],
  )
  const draftThinkingLevel = useMemo(
    () => pickThinking(chatOptions, draftModel ? refOf(draftModel) : '', draft.thinkingLevel),
    [chatOptions, draftModel, draft.thinkingLevel],
  )

  const controller: ChatController = {
    api,
    homes,
    home,
    setHome,
    options: chatOptions,
    optionsError,
    refreshOptions,
    chats,
    active,
    activeId,
    selectChat,
    startNewChat,
    transcript,
    partial,
    thinking,
    streaming,
    pending,
    runningTools,
    retry,
    compacting,
    connectionLost,
    error,
    notice,
    clearNotice: () => setNotice(null),
    uiRequests,
    draft: { ...draft, thinkingLevel: draftThinkingLevel },
    setDraft,
    draftModel,
    draftThinkingLevel,
    activeModel,
    sending,
    submit,
    resume,
    abort,
    switchModel,
    setThinkingLevel,
    answer,
    close,
    openTrajectory,
    canOpenTrajectory: Boolean(options.openSessionInSessions && active?.sessionFile),
  }

  return <ChatContext.Provider value={controller}>{children}</ChatContext.Provider>
}

export function useChatController(): ChatController {
  const value = useContext(ChatContext)
  if (!value) throw new Error('useChatController 必须在 ChatProvider 内使用')
  return value
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const apiError = error as ApiError
    return apiError.message
  }
  return String(error)
}

// ---------------------------------------------------------------------------
// 模型与思考档位的取值规则
// ---------------------------------------------------------------------------

/** 只按第一个斜杠拆：modelId 本身可以含斜杠（`gab-chat/GLM-5.3`）。 */
export function splitRef(ref: string): [string, string] {
  const slash = ref.indexOf('/')
  return slash <= 0 ? ['', ''] : [ref.slice(0, slash), ref.slice(slash + 1)]
}

function refOf(model: ChatModelOption): string {
  return `${model.provider}/${model.id}`
}

function pickModelOption(options: ChatOptions | null, ref: string): ChatModelOption | null {
  if (!options || !ref) return null
  return options.models.find((model) => refOf(model) === ref) ?? null
}

/**
 * 挑一个仍然有效的模型：草稿里的模型不在候选范围（目录刷新、enabledModels
 * 改动、换 home）时回落到该 home 的默认模型。
 */
function pickModel(options: ChatOptions | null, current: string): string {
  if (!options) return current
  if (current && options.models.some((model) => refOf(model) === current)) return current
  return options.defaultModel ?? (options.models[0] ? refOf(options.models[0]) : '')
}

/**
 * 思考档位：当前值仍受该模型支持就保留，否则用「该模型默认」（`:level` 钉住 >
 * 全局默认 > 该模型支持的最低档）。
 */
function pickThinking(options: ChatOptions | null, modelRef: string, current: string): string {
  const model = pickModelOption(options, modelRef)
  if (!model) return current
  const levels = model.thinkingLevels.length > 0 ? model.thinkingLevels : [NO_THINKING]
  if (current && levels.includes(current)) return current
  const pin = options?.thinkingLevelPins[modelRef]
  if (pin && levels.includes(pin)) return pin
  if (options?.defaultThinkingLevel && levels.includes(options.defaultThinkingLevel)) {
    return options.defaultThinkingLevel
  }
  return levels.includes(NO_THINKING) ? NO_THINKING : levels[0]
}

/** 会话里的模型可能不在当前候选范围（续聊、范围收窄）：按会话值造一个只读项。 */
function modelOptionFor(options: ChatOptions | null, ref: string | null): ChatModelOption | null {
  if (!ref) return null
  const known = pickModelOption(options, ref)
  if (known) return known
  const [provider, id] = splitRef(ref)
  if (!provider || !id) return null
  return {
    provider,
    providerName: provider,
    id,
    name: id,
    reasoning: false,
    images: false,
    thinkingLevels: [],
    thinkingLevelMap: null,
  }
}

function readLocal(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* 隐私模式下写不进去，按不记忆处理 */
  }
}

/** 等事件流握上手（首帧到达）；超时也继续，不把发送卡死。 */
async function waitForStream(
  ref: { current: Set<string> },
  sessionId: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ref.current.has(sessionId)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function readJson<T>(key: string): T | null {
  const raw = readLocal(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
