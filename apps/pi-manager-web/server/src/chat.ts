import type http from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { listAgentProfiles } from './agents.ts'
import { HomeError } from './pi-home.ts'
import { readSettings } from './settings-file.ts'
import { catalogCwd, readCachedCatalog } from './models-runtime.ts'
import {
  assembleSession,
  disposeSession,
  resolveCwd,
  sessionRoot,
  THINKING_LEVELS,
  type AgentSession,
  type ThinkingLevel,
} from './session-runtime.ts'

/**
 * 交互对话的运行时。
 *
 * 对话与一次性任务共用 `session-runtime.ts` 的装配与释放规则；区别只在于会话
 * 保持存活、事件转发给浏览器、可以一直发消息。
 *
 * 传输用 SSE：事件单向，发送用普通 POST，反代与鉴权都按普通 HTTP 处理。
 * 首帧回放会话行文本（与 pi 会话文件同形状），浏览器用同一个 `parsePiJsonl`
 * 解析，因此对话与会话浏览共用一份渲染。
 *
 * 进程内状态不落盘：重启后浏览器按 sessionFile 续聊。
 */

export type ChatState = 'idle' | 'running' | 'error'

export interface ChatInfo {
  sessionId: string
  home: string
  cwd: string
  model: string | null
  thinkingLevel: string | null
  sessionFile: string | null
  name: string | null
  state: ChatState
  isStreaming: boolean
  partial: string
  pendingCount: number
  error: string | null
  startedAt: number
  updatedAt: number
}

interface UiRequest {
  resolve: (value: unknown) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

interface ChatRecord extends ChatInfo {
  session: AgentSession
  unsubscribe: () => void
  transcript: string
  subscribers: Set<http.ServerResponse>
  uiPending: Map<string, UiRequest>
  pendingDelta: string
  flushTimer: NodeJS.Timeout | null
  lastActivity: number
}

const MAX_CHATS = Number.parseInt(process.env.PI_MANAGER_MAX_CHATS ?? '8', 10) || 8
const IDLE_MS = Number.parseInt(process.env.PI_MANAGER_CHAT_IDLE_MS ?? String(30 * 60_000), 10) || 30 * 60_000
const UI_TIMEOUT_MS = Number.parseInt(process.env.PI_MANAGER_CHAT_UI_TIMEOUT_MS ?? '120000', 10) || 120_000
const DELTA_FLUSH_MS = 50

const chats = new Map<string, ChatRecord>()

export function chatCapacity(): { open: number; limit: number } {
  return { open: chats.size, limit: MAX_CHATS }
}

export function listChats(home?: string): ChatInfo[] {
  const all = [...chats.values()]
  return (home ? all.filter((chat) => chat.home === home) : all)
    .map(publicInfo)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getChat(sessionId: string): ChatInfo | null {
  const chat = chats.get(sessionId)
  return chat ? publicInfo(chat) : null
}

function publicInfo(chat: ChatRecord): ChatInfo {
  return {
    sessionId: chat.sessionId,
    home: chat.home,
    cwd: chat.cwd,
    model: chat.model,
    thinkingLevel: chat.thinkingLevel,
    sessionFile: chat.sessionFile,
    name: chat.name,
    state: chat.state,
    isStreaming: chat.session.isStreaming,
    partial: chat.partial,
    pendingCount: chat.pendingCount,
    error: chat.error,
    startedAt: chat.startedAt,
    updatedAt: chat.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// 对话可选项：模型、默认值、agent 清单、会话根
// ---------------------------------------------------------------------------

export function chatOptions(home: string): {
  models: Array<{ provider: string; id: string; enabled: boolean }>
  defaultModel: string | null
  defaultThinkingLevel: string | null
  thinkingLevels: readonly string[]
  agents: string[]
  sessionRoot: string
  sessionRootExists: boolean
  defaultCwd: string
} {
  const settings = readSettings(home).data as {
    defaultProvider?: unknown
    defaultModel?: unknown
    defaultThinkingLevel?: unknown
    enabledModels?: unknown
  }
  const catalog = readCachedCatalog(home, catalogCwd())
  const enabled = Array.isArray(settings.enabledModels)
    ? new Set(
        settings.enabledModels
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.toLowerCase()),
      )
    : null
  // `enabledModels` 缺省等于「全部可用」，与 pi 的语义一致。
  const models = (catalog?.models ?? []).map((model) => ({
    provider: model.provider,
    id: model.id,
    enabled: enabled === null ? true : enabled.has(`${model.provider}/${model.id}`.toLowerCase()),
  }))
  const provider = typeof settings.defaultProvider === 'string' ? settings.defaultProvider : ''
  const modelId = typeof settings.defaultModel === 'string' ? settings.defaultModel : ''
  const root = sessionRoot(home)
  return {
    models,
    defaultModel: provider && modelId ? `${provider}/${modelId}` : null,
    defaultThinkingLevel:
      typeof settings.defaultThinkingLevel === 'string' ? settings.defaultThinkingLevel : null,
    thinkingLevels: [...THINKING_LEVELS],
    agents: listAgentProfiles(home).map((profile) => profile.file.replace(/\.md$/i, '')),
    sessionRoot: root,
    sessionRootExists: existsSync(root) && statSync(root).isDirectory(),
    defaultCwd: resolveCwd(undefined),
  }
}

// ---------------------------------------------------------------------------
// 扩展 UI 桥接
// ---------------------------------------------------------------------------

/**
 * 扩展的交互请求（确认、选择、输入）转成帧，等浏览器回执。
 *
 * `ExtensionUIContext` 有二十多个成员，TUI 专属能力做成 headless stub（静默丢弃
 * 或降级成通知）；只有对话框类方法需要真正实现。
 */
function createUiContext(getChatId: () => string | null) {
  const request = (
    kind: 'confirm' | 'select' | 'input',
    title: string,
    payload: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeout?: number },
  ): Promise<unknown> => {
    const chatId = getChatId()
    const chat = chatId ? chats.get(chatId) : null
    if (!chat) return Promise.reject(new Error('对话已结束'))
    const requestId = randomUUID()
    const timeoutMs = Math.min(opts?.timeout ?? UI_TIMEOUT_MS, UI_TIMEOUT_MS)
    return new Promise((resolve) => {
      const finish = (value: unknown) => {
        const pending = chat.uiPending.get(requestId)
        if (!pending) return
        chat.uiPending.delete(requestId)
        clearTimeout(pending.timer)
        if (pending.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort)
        resolve(value)
      }
      const timer = setTimeout(() => finish(kind === 'confirm' ? false : undefined), timeoutMs)
      const onAbort = () => finish(kind === 'confirm' ? false : undefined)
      opts?.signal?.addEventListener('abort', onAbort, { once: true })
      chat.uiPending.set(requestId, { resolve: finish, timer, signal: opts?.signal, onAbort })
      broadcast(chat, { type: 'extension_ui_request', requestId, kind, title, timeoutMs, ...payload })
    })
  }

  const notify = (message: string, type?: string): void => {
    const chatId = getChatId()
    const chat = chatId ? chats.get(chatId) : null
    if (chat) broadcast(chat, { type: 'notify', message, level: type ?? 'info' })
  }

  // 只实现 headless 环境有意义的成员，其余为 no-op；调用方按 ExtensionUIContext 使用。
  const stub = {
    select: (title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) =>
      request('select', title, { options }, opts) as Promise<string | undefined>,
    confirm: (title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
      request('confirm', title, { message }, opts) as Promise<boolean>,
    input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
      request('input', title, { placeholder }, opts) as Promise<string | undefined>,
    notify,
    onTerminalInput: () => () => undefined,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: () => Promise.reject(new Error('对话界面不支持自定义组件')),
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => '',
    editor: (title: string, prefill?: string) =>
      request('input', title, { placeholder: prefill ?? '' }) as Promise<string | undefined>,
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getTheme: () => undefined,
    getAllThemes: () => [],
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  }
  return stub
}

// ---------------------------------------------------------------------------
// 建会话
// ---------------------------------------------------------------------------

export interface CreateChatOptions {
  home: string
  cwd?: string
  model?: string
  thinkingLevel?: string
  subagent?: string | null
  sessionFile?: string | null
}

export async function createChat(options: CreateChatOptions): Promise<ChatInfo> {
  if (chats.size >= MAX_CHATS) {
    throw new HomeError(
      `同时打开的对话已达上限 ${MAX_CHATS}，先关掉一个再开`,
      429,
      'too_many_chats',
    )
  }

  let chatId: string | null = null
  const uiContext = createUiContext(() => chatId)

  const assembled = await assembleSession({
    home: options.home,
    cwd: options.cwd,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    subagent: options.subagent,
    sessionFile: options.sessionFile,
    uiContext: uiContext as never,
    abortHandler: () => {
      if (chatId) void abortChat(chatId)
    },
  })

  const existing = chats.get(assembled.sessionId)
  if (existing) {
    // 同一会话文件不能有两个运行时并行追加：丢掉这份新装配的会话，接到已有对话上。
    await disposeSession(assembled.session, options.home)
    existing.lastActivity = Date.now()
    return { ...publicInfo(existing), fallbackMessage: null } as ChatInfo & {
      fallbackMessage: string | null
    }
  }

  chatId = assembled.sessionId
  const chat: ChatRecord = {
    sessionId: assembled.sessionId,
    home: options.home,
    cwd: assembled.cwd,
    model: assembled.model,
    thinkingLevel: assembled.thinkingLevel,
    sessionFile: assembled.sessionFile,
    name: null,
    state: 'idle',
    isStreaming: false,
    partial: '',
    pendingCount: 0,
    error: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    session: assembled.session,
    unsubscribe: () => undefined,
    transcript: transcriptOf(assembled.session),
    subscribers: new Set(),
    uiPending: new Map(),
    pendingDelta: '',
    flushTimer: null,
    lastActivity: Date.now(),
  }
  chat.unsubscribe = assembled.session.subscribe((event) => handleEvent(chat, event))
  chats.set(chat.sessionId, chat)
  ensureReaper()
  return { ...publicInfo(chat), fallbackMessage: assembled.fallbackMessage } as ChatInfo & {
    fallbackMessage: string | null
  }
}

function transcriptOf(session: AgentSession): string {
  const header = session.sessionManager.getHeader()
  const entries = session.sessionManager.getEntries()
  const lines: string[] = []
  if (header) lines.push(JSON.stringify(header))
  for (const entry of entries) lines.push(JSON.stringify(entry))
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

// ---------------------------------------------------------------------------
// 事件转发
// ---------------------------------------------------------------------------

function handleEvent(chat: ChatRecord, event: { type: string } & Record<string, unknown>): void {
  chat.updatedAt = Date.now()
  chat.lastActivity = chat.updatedAt
  switch (event.type) {
    case 'agent_start':
      chat.state = 'running'
      chat.error = null
      broadcast(chat, { type: 'agent_start' })
      break
    case 'agent_settled':
      flushDelta(chat)
      chat.state = 'idle'
      chat.partial = ''
      refreshTranscript(chat)
      broadcast(chat, { type: 'agent_settled', aborted: event.aborted === true })
      break
    case 'message_start':
      chat.partial = ''
      broadcast(chat, { type: 'message_start' })
      break
    case 'message_update': {
      const assistant = event.assistantMessageEvent as { type?: string; delta?: string } | undefined
      if (assistant?.type === 'text_delta' && typeof assistant.delta === 'string') {
        chat.partial += assistant.delta
        chat.pendingDelta += assistant.delta
        scheduleDelta(chat)
      }
      broadcast(chat, { type: 'message_update', assistant: assistant ?? null })
      break
    }
    case 'message_end':
      flushDelta(chat)
      chat.partial = ''
      refreshTranscript(chat)
      broadcast(chat, { type: 'message_end' })
      break
    case 'turn_end':
      refreshTranscript(chat)
      broadcast(chat, { type: 'turn_end' })
      break
    case 'compaction_end':
      refreshTranscript(chat)
      broadcast(chat, { type: 'compaction_end' })
      break
    case 'entry_appended':
      // SDK 目前并不总是发这个事件，落盘后仍以 refreshTranscript 的整段回放为准。
      flushDelta(chat)
      refreshTranscript(chat)
      break
    case 'queue_update': {
      const steering = Array.isArray(event.steering) ? event.steering : []
      const followUp = Array.isArray(event.followUp) ? event.followUp : []
      chat.pendingCount = steering.length + followUp.length
      broadcast(chat, { type: 'queue_update', steering, followUp })
      break
    }
    case 'thinking_level_changed':
      chat.thinkingLevel = typeof event.level === 'string' ? event.level : chat.thinkingLevel
      broadcast(chat, { type: 'thinking_level_changed', level: event.level })
      break
    case 'session_info_changed':
      chat.name = typeof event.name === 'string' ? event.name : null
      broadcast(chat, { type: 'session_info_changed', name: event.name ?? null })
      break
    case 'agent_end':
      break
    default:
      broadcast(chat, { type: event.type, event })
  }
}

/**
 * 用会话管理器里的条目重建整段行文本并推给浏览器。
 *
 * 不依赖 `entry_appended`（实测不触发）：消息落盘后一次性把整段文本发过去，
 * 浏览器仍然用同一个 `parsePiJsonl` 解析，与大文件回放走同一条路径。
 */
function refreshTranscript(chat: ChatRecord): void {
  const next = transcriptOf(chat.session)
  if (next === chat.transcript) return
  chat.transcript = next
  broadcast(chat, { type: 'transcript', jsonl: next })
}

function scheduleDelta(chat: ChatRecord): void {
  if (chat.flushTimer) return
  chat.flushTimer = setTimeout(() => {
    chat.flushTimer = null
    flushDelta(chat)
  }, DELTA_FLUSH_MS)
}

function flushDelta(chat: ChatRecord): void {
  if (!chat.pendingDelta) return
  const text = chat.pendingDelta
  chat.pendingDelta = ''
  broadcast(chat, { type: 'delta', text })
}

function broadcast(chat: ChatRecord, frame: Record<string, unknown>): void {
  const payload = `data: ${JSON.stringify(frame)}\n\n`
  for (const subscriber of chat.subscribers) {
    try {
      subscriber.write(payload)
    } catch {
      chat.subscribers.delete(subscriber)
    }
  }
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

export async function promptChat(sessionId: string, text: string, mode?: 'steer' | 'followUp'): Promise<void> {
  const chat = requireChat(sessionId)
  const trimmed = text.trim()
  if (!trimmed) throw new HomeError('消息不能为空', 400, 'invalid_request')
  chat.lastActivity = Date.now()
  try {
    // 流式期间 SDK 要求显式指定排队方式，缺了会直接抛错。
    await chat.session.prompt(
      trimmed,
      chat.session.isStreaming || chat.pendingCount > 0 ? { streamingBehavior: mode ?? 'followUp' } : undefined,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    chat.error = message
    chat.state = 'error'
    broadcast(chat, { type: 'error', message })
    throw new HomeError(message, 400, 'prompt_failed')
  }
}

export async function abortChat(sessionId: string): Promise<{ steering: string[]; followUp: string[] }> {
  const chat = requireChat(sessionId)
  const cleared = chat.session.clearQueue()
  await chat.session.abort()
  chat.pendingCount = 0
  broadcast(chat, { type: 'queue_update', steering: [], followUp: [] })
  return { steering: [...(cleared.steering ?? [])], followUp: [...(cleared.followUp ?? [])] }
}

export async function setChatModel(
  sessionId: string,
  provider: string,
  modelId?: string,
  thinkingLevel?: string,
): Promise<ChatInfo> {
  const chat = requireChat(sessionId)
  const current = chat.session.model
  const targetId = modelId ?? current?.id
  if (!targetId) throw new HomeError('modelId 必填', 400, 'invalid_request')
  const model = chat.session.modelRuntime.getModel(provider, targetId)
  if (!model) {
    throw new HomeError(`该 pi home 里没有这个模型：${provider}/${targetId}`, 404, 'model_not_found')
  }
  await chat.session.setModel(model)
  if (thinkingLevel) chat.session.setThinkingLevel(thinkingLevel as ThinkingLevel)
  chat.model = `${model.provider}/${model.id}`
  chat.thinkingLevel = chat.session.thinkingLevel ?? chat.thinkingLevel
  chat.updatedAt = Date.now()
  return publicInfo(chat)
}

export function answerUiRequest(sessionId: string, requestId: string, value: unknown): void {
  const chat = requireChat(sessionId)
  const pending = chat.uiPending.get(requestId)
  if (!pending) throw new HomeError(`没有这个待回答的请求：${requestId}`, 404, 'ui_request_not_found')
  pending.resolve(value)
}

export async function closeChat(sessionId: string): Promise<void> {
  const chat = chats.get(sessionId)
  if (!chat) return
  await disposeChat(chat)
}

export async function disposeAllChats(): Promise<void> {
  await Promise.all([...chats.values()].map((chat) => disposeChat(chat)))
}

async function disposeChat(chat: ChatRecord): Promise<void> {
  chats.delete(chat.sessionId)
  for (const pending of chat.uiPending.values()) {
    clearTimeout(pending.timer)
    pending.resolve(undefined)
  }
  chat.uiPending.clear()
  if (chat.flushTimer) clearTimeout(chat.flushTimer)
  chat.unsubscribe()
  for (const subscriber of chat.subscribers) {
    try {
      subscriber.end()
    } catch {
      /* 已断开 */
    }
  }
  chat.subscribers.clear()
  await disposeSession(chat.session, chat.home)
}

function requireChat(sessionId: string): ChatRecord {
  const chat = chats.get(sessionId)
  if (!chat) throw new HomeError(`没有这个对话：${sessionId}`, 404, 'chat_not_found')
  return chat
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

export function attachChatStream(sessionId: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const chat = requireChat(sessionId)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // 反代上不要缓冲，否则流式变成一次性输出。
    'X-Accel-Buffering': 'no',
  })
  const send = (frame: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(frame)}\n\n`)
  }
  // 首帧回放已落盘内容，第二帧补当前状态（含流式中的半截文本）。
  send({ type: 'transcript', jsonl: chat.transcript })
  send({ type: 'state', ...publicInfo(chat) })
  chat.subscribers.add(res)

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      /* 忽略 */
    }
  }, 15_000)
  ping.unref?.()

  const cleanup = () => {
    clearInterval(ping)
    chat.subscribers.delete(res)
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}

// ---------------------------------------------------------------------------
// 空闲回收
// ---------------------------------------------------------------------------

let reaper: NodeJS.Timeout | null = null

function ensureReaper(): void {
  if (reaper) return
  reaper = setInterval(() => {
    const now = Date.now()
    for (const chat of [...chats.values()]) {
      if (now - chat.lastActivity < IDLE_MS) continue
      if (chat.session.isStreaming) continue
      void disposeChat(chat)
    }
  }, 60_000)
  reaper.unref?.()
}
