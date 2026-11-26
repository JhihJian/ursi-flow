import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  createApiClient,
  type ApiError,
  type ChatInfo,
  type ChatOptions,
  type HomeSummary,
} from '@ursi/pi-manager-web/client'

/**
 * 对话模块的共享状态。
 *
 * 数据来自管理台的运行时：本模块不加载 SDK、不读写配置、不碰会话文件。
 * 侧边栏与工作区在 DOM 上是两块，因此这里只放纯状态，不渲染布局。
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
}

export interface ChatDraft {
  /** 空串表示用该 home 的默认模型。 */
  model: string
  thinkingLevel: string
  cwd: string
  subagent: string
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
  transcript: string
  partial: string
  streaming: boolean
  pending: number
  error: string | null
  notice: Notice | null
  clearNotice: () => void
  uiRequests: UiRequest[]
  draft: ChatDraft
  setDraft: (patch: Partial<ChatDraft>) => void
  creating: boolean
  createChat: () => Promise<void>
  resume: (sessionFile: string) => Promise<ChatInfo | null>
  send: (text: string, mode?: 'steer' | 'followUp') => Promise<void>
  abort: () => Promise<void>
  switchModel: (provider: string, modelId: string, thinkingLevel?: string) => Promise<void>
  answer: (requestId: string, value: unknown) => Promise<void>
  close: () => Promise<void>
  openTrajectory: () => Promise<void>
  canOpenTrajectory: boolean
}

const EMPTY_DRAFT: ChatDraft = { model: '', thinkingLevel: '', cwd: '', subagent: '' }

const ChatContext = createContext<ChatController | null>(null)

export function ChatProvider({
  options,
  children,
}: {
  options: ChatControllerOptions
  children: ReactNode
}) {
  const api = useMemo(() => createApiClient(options.managerApiBaseUrl ?? ''), [options.managerApiBaseUrl])
  const storageKey = options.storageKey ?? 'pi-chat'

  const [homes, setHomes] = useState<HomeSummary[]>([])
  const [home, setHomeState] = useState<string>(() => readLocal(`${storageKey}:home`))
  const [chatOptions, setChatOptions] = useState<ChatOptions | null>(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [chats, setChats] = useState<ChatInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [transcript, setTranscript] = useState('')
  const [partial, setPartial] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [pending, setPending] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [uiRequests, setUiRequests] = useState<UiRequest[]>([])
  const [draft, setDraftState] = useState<ChatDraft>(EMPTY_DRAFT)
  const [creating, setCreating] = useState(false)

  const notify = useCallback(
    (next: Notice) => {
      if (options.onNotice) options.onNotice(next)
      else setNotice(next)
    },
    [options.onNotice],
  )

  const active = chats.find((chat) => chat.sessionId === activeId) ?? null

  /** 记住的 home 优先，其次第一个有效 home。 */
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
          if (fallback) writeLocal(`${storageKey}:home`, fallback)
          return fallback
        })
      })
      .catch((failure: unknown) => {
        if (alive) setOptionsError(errorText(failure))
      })
    return () => {
      alive = false
    }
  }, [api, storageKey])

  const refreshOptions = useCallback(async () => {
    if (!home) {
      setChatOptions(null)
      return
    }
    try {
      const next = await api.getChatOptions(home)
      setChatOptions(next)
      setOptionsError(null)
      // 草稿里的模型与 cwd 沿用上次选择，失效时回落到服务端默认。
      setDraftState((current) => ({
        ...current,
        cwd: current.cwd || next.defaultCwd,
        model: next.models.some((model) => `${model.provider}/${model.id}` === current.model)
          ? current.model
          : (next.defaultModel ?? ''),
        thinkingLevel: current.thinkingLevel || (next.defaultThinkingLevel ?? ''),
      }))
    } catch (failure) {
      setOptionsError(errorText(failure))
      setChatOptions(null)
    }
  }, [api, home])

  useEffect(() => {
    void refreshOptions()
  }, [refreshOptions])

  const refreshChats = useCallback(async () => {
    try {
      const listing = await api.listChats()
      setChats(listing.chats)
    } catch {
      /* 列表失败不清空已有内容 */
    }
  }, [api])

  useEffect(() => {
    void refreshChats()
    const timer = setInterval(() => void refreshChats(), 5_000)
    return () => clearInterval(timer)
  }, [refreshChats])

  const setHome = useCallback(
    (path: string) => {
      setActiveId(null)
      setTranscript('')
      setPartial('')
      setUiRequests([])
      setDraftState(EMPTY_DRAFT)
      writeLocal(`${storageKey}:home`, path)
      setHomeState(path)
    },
    [storageKey],
  )

  const setDraft = useCallback((patch: Partial<ChatDraft>) => {
    setDraftState((current) => ({ ...current, ...patch }))
  }, [])

  const selectChat = useCallback((sessionId: string | null) => {
    setActiveId(sessionId)
    setTranscript('')
    setPartial('')
    setUiRequests([])
    setError(null)
  }, [])

  /** 事件流：首帧回放已落盘内容，随后增量。重连时整段重放，不丢已落盘部分。 */
  useEffect(() => {
    if (!activeId) return
    setPartial('')
    setError(null)
    let alive = true
    const source = new EventSource(api.chatStreamUrl(activeId))

    source.onmessage = (event) => {
      if (!alive) return
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(event.data) as Record<string, unknown>
      } catch {
        return
      }
      const type = frame.type
      if (type === 'transcript') {
        setTranscript(typeof frame.jsonl === 'string' ? frame.jsonl : '')
        return
      }
      if (type === 'state') {
        setStreaming(frame.isStreaming === true)
        setPartial(typeof frame.partial === 'string' ? frame.partial : '')
        setPending(typeof frame.pendingCount === 'number' ? frame.pendingCount : 0)
        return
      }
      if (type === 'delta') {
        setPartial((current) => current + (typeof frame.text === 'string' ? frame.text : ''))
        return
      }
      if (type === 'message_start') {
        setPartial('')
        return
      }
      if (type === 'entry_appended') {
        const entry = frame.entry
        if (entry) setTranscript((current) => `${current}${JSON.stringify(entry)}\n`)
        setPartial('')
        return
      }
      if (type === 'agent_start') {
        setStreaming(true)
        setError(null)
        return
      }
      if (type === 'agent_settled') {
        setStreaming(false)
        setPartial('')
        return
      }
      if (type === 'queue_update') {
        const steering = Array.isArray(frame.steering) ? frame.steering.length : 0
        const followUp = Array.isArray(frame.followUp) ? frame.followUp.length : 0
        setPending(steering + followUp)
        return
      }
      if (type === 'extension_ui_request') {
        setUiRequests((current) => [
          ...current,
          {
            requestId: String(frame.requestId ?? ''),
            kind: (frame.kind as UiRequest['kind']) ?? 'confirm',
            title: String(frame.title ?? ''),
            message: typeof frame.message === 'string' ? frame.message : undefined,
            options: Array.isArray(frame.options) ? (frame.options as string[]) : undefined,
            placeholder: typeof frame.placeholder === 'string' ? frame.placeholder : undefined,
            timeoutMs: typeof frame.timeoutMs === 'number' ? frame.timeoutMs : 120_000,
          },
        ])
        return
      }
      if (type === 'notify') {
        notify({ kind: 'info', message: String(frame.message ?? '') })
        return
      }
      if (type === 'error') {
        setError(String(frame.message ?? '对话出错'))
      }
    }
    source.onerror = () => {
      // EventSource 会自己重连；这里只提示一次状态。
      if (alive) setStreaming(false)
    }
    return () => {
      alive = false
      source.close()
    }
  }, [activeId, api, notify])

  const createChat = useCallback(async () => {
    if (!home) {
      notify({ kind: 'error', message: '先在左侧选择一份 pi home' })
      return
    }
    setCreating(true)
    setError(null)
    try {
      const chat = await api.createChat({
        home,
        ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
        ...(draft.subagent ? { subagent: draft.subagent } : {}),
      })
      setChats((current) => [chat, ...current.filter((item) => item.sessionId !== chat.sessionId)])
      selectChat(chat.sessionId)
      if (chat.fallbackMessage) notify({ kind: 'info', message: chat.fallbackMessage })
    } catch (failure) {
      notify({ kind: 'error', message: errorText(failure) })
    } finally {
      setCreating(false)
    }
  }, [api, draft, home, notify, selectChat])

  const resume = useCallback(
    async (sessionFile: string) => {
      setCreating(true)
      try {
        const chat = await api.createChat({ sessionFile })
        setChats((current) => [chat, ...current.filter((item) => item.sessionId !== chat.sessionId)])
        selectChat(chat.sessionId)
        return chat
      } catch (failure) {
        notify({ kind: 'error', message: errorText(failure) })
        return null
      } finally {
        setCreating(false)
      }
    },
    [api, notify, selectChat],
  )

  const send = useCallback(
    async (text: string, mode?: 'steer' | 'followUp') => {
      if (!activeId) return
      try {
        await api.promptChat(activeId, text, mode)
      } catch (failure) {
        setError(errorText(failure))
      }
    },
    [activeId, api],
  )

  const abort = useCallback(async () => {
    if (!activeId) return
    try {
      const cleared = await api.abortChat(activeId)
      setPending(0)
      const restored = [...cleared.followUp, ...cleared.steering].join('\n')
      if (restored) {
        setNotice({ kind: 'info', message: `已中止；排队中的消息已放回输入框：${restored}` })
      }
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [activeId, api])

  const switchModel = useCallback(
    async (provider: string, modelId: string, thinkingLevel?: string) => {
      if (!activeId) return
      try {
        const next = await api.setChatModel(activeId, provider, modelId, thinkingLevel)
        setChats((current) => current.map((item) => (item.sessionId === next.sessionId ? next : item)))
      } catch (failure) {
        setError(errorText(failure))
      }
    },
    [activeId, api],
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

  const close = useCallback(async () => {
    if (!activeId) return
    const id = activeId
    try {
      await api.closeChat(id)
    } catch {
      /* 关闭失败也把本地状态清掉 */
    }
    setChats((current) => current.filter((item) => item.sessionId !== id))
    selectChat(null)
    void refreshChats()
  }, [activeId, api, refreshChats, selectChat])

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
    transcript,
    partial,
    streaming,
    pending,
    error,
    notice,
    clearNotice: () => setNotice(null),
    uiRequests,
    draft,
    setDraft,
    creating,
    createChat,
    resume,
    send,
    abort,
    switchModel,
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
