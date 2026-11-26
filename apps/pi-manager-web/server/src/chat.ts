import type http from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { listAgentProfiles } from './agents.ts'
import { HomeError } from './pi-home.ts'
import { loadSdk } from './sdk.ts'
import { catalogCwd, readCachedCatalog } from './models-runtime.ts'
import {
  assembleSession,
  disposeSession,
  resolveCwd,
  sessionRoot,
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
  /** 当前流式中的思考文本；没有则为空串。 */
  partialThinking: string
  pendingCount: number
  error: string | null
  startedAt: number
  updatedAt: number
}

interface UiRequest {
  kind: 'confirm' | 'select' | 'input'
  /** 重连时原样重发的帧，浏览器据此重建对话框。 */
  frame: Record<string, unknown>
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
  pendingThinkingDelta: string
  flushTimer: NodeJS.Timeout | null
  /** 中止扩展 UI 对话框：按 Esc 不该被一个等确认的扩展拖住两分钟。 */
  stopController: AbortController
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
    partialThinking: chat.partialThinking,
    pendingCount: chat.pendingCount,
    error: chat.error,
    startedAt: chat.startedAt,
    updatedAt: chat.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// 对话可选项：模型、默认值、agent 清单、会话根
// ---------------------------------------------------------------------------

export interface ChatModelOption {
  provider: string
  providerName: string
  id: string
  name: string
  reasoning: boolean
  images: boolean
  /** 该模型接受的思考档位；与 pi 的 `getSupportedThinkingLevels` 同一口径。 */
  thinkingLevels: string[]
  thinkingLevelMap: Record<string, string | null> | null
}

export interface ChatOptionsView {
  models: ChatModelOption[]
  /** `enabledModels` 真的限定了范围（解析出至少一个模型）时为 true。 */
  isScoped: boolean
  scopeWarnings: string[]
  defaultModel: string | null
  defaultThinkingLevel: string | null
  /** `enabledModels` 里用 `:level` 钉住的档位，按 `provider/modelId` 索引。 */
  thinkingLevelPins: Record<string, string>
  agents: string[]
  sessionRoot: string
  sessionRootExists: boolean
  defaultCwd: string
  /** 运行时目录采集时间；null 表示还没采集过。 */
  catalogFetchedAt: number | null
}

/**
 * 对话可选项。
 *
 * 模型候选跟 pi 的 `/model` 选择器同一份口径：`enabledModels` 决定可见范围
 * （支持 glob、模糊匹配与 `:thinkingLevel` 后缀，解析不到时回退到全部可用），
 * 不在范围内的模型不返回。思考档位按模型给，不再是一张全局表。
 */
export async function chatOptions(home: string): Promise<ChatOptionsView> {
  const sdk = await loadSdk()
  const cwd = catalogCwd()
  // 与真实会话同一份合并规则：全局 settings.json 叠加项目级 .pi/settings.json。
  const settings = sdk.SettingsManager.create(cwd, home)
  const catalog = readCachedCatalog(home, cwd)
  const all = catalog?.models ?? []
  const provider = settings.getDefaultProvider() ?? ''
  const modelId = settings.getDefaultModel() ?? ''
  const savedDefault = provider && modelId ? `${provider}/${modelId}` : null

  // 目录未采集时只能回默认值：界面提示去管理台刷新目录，不编造候选。
  if (all.length === 0) {
    const root = sessionRoot(home)
    return {
      models: [],
      isScoped: false,
      scopeWarnings: [],
      defaultModel: savedDefault,
      defaultThinkingLevel: settings.getDefaultThinkingLevel() ?? null,
      thinkingLevelPins: {},
      agents: listAgentProfiles(home).map((profile) => profile.file.replace(/\.md$/i, '')),
      sessionRoot: root,
      sessionRootExists: existsSync(root) && statSync(root).isDirectory(),
      defaultCwd: resolveCwd(undefined),
      catalogFetchedAt: catalog?.fetchedAt ?? null,
    }
  }

  // 范围解析只用模型表本身（provider / id / name），不需要再起一次运行时。
  const patterns = (settings.getEnabledModels() ?? []).map((item) => item.trim()).filter(Boolean)
  const scope =
    patterns.length > 0
      ? await sdk.resolveModelScopeWithDiagnostics(patterns, {
          getAvailable: async () => all,
        } as never)
      : { scopedModels: [], diagnostics: [] }
  const isScoped = scope.scopedModels.length > 0
  const visible = isScoped ? scope.scopedModels.map((scoped) => scoped.model) : all
  const pins = new Map<string, string>()
  for (const scoped of scope.scopedModels) {
    if (scoped.thinkingLevel) pins.set(modelRef(scoped.model), scoped.thinkingLevel)
  }

  const providerNames = new Map((catalog?.providers ?? []).map((entry) => [entry.id, entry.name]))
  const byRef = new Map(all.map((model) => [modelRef(model), model]))
  const models: ChatModelOption[] = visible.map((model) => {
    const ref = modelRef(model)
    const meta = byRef.get(ref)
    return {
      provider: model.provider,
      providerName: providerNames.get(model.provider) ?? model.provider,
      id: model.id,
      name: meta?.name ?? model.id,
      reasoning: meta?.reasoning ?? false,
      images: meta?.images ?? false,
      // 老缓存没有逐模型档位：按 reasoning 退回 pi 的基础档位（xhigh/max 需要显式映射）。
      thinkingLevels: meta?.thinkingLevels ?? (meta?.reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : ['off']),
      thinkingLevelMap: meta?.thinkingLevelMap ?? null,
    }
  })

  // 默认模型：settings 的默认值在范围内才生效，否则用范围首项，再退到首个可见模型。
  const defaultModel =
    savedDefault && models.some((model) => modelRef(model) === savedDefault)
      ? savedDefault
      : (visible[0] ? modelRef(visible[0]) : null)

  // 思考级别：`:level` 钉住 > 该模型的单独设置 > 全局默认，与 pi 启动时一致。
  // 再按该模型支持的档位收一下就得到服务端实际会用的值，界面与服务端不出现两个数。
  const [defaultProvider, defaultModelId] = defaultModel ? splitModelRef(defaultModel) : ['', '']
  const defaultThinkingLevel = defaultModel
    ? clampThinking(
        pins.get(defaultModel) ??
          settings.getModelThinkingLevel(defaultProvider, defaultModelId) ??
          settings.getDefaultThinkingLevel() ??
          '',
        byRef.get(defaultModel)?.thinkingLevels ?? [],
      )
    : (settings.getDefaultThinkingLevel() ?? null)

  const root = sessionRoot(home)
  return {
    models,
    isScoped,
    scopeWarnings: scope.diagnostics.map((diagnostic) => diagnostic.message),
    defaultModel,
    defaultThinkingLevel,
    thinkingLevelPins: Object.fromEntries(pins),
    agents: listAgentProfiles(home).map((profile) => profile.file.replace(/\.md$/i, '')),
    sessionRoot: root,
    sessionRootExists: existsSync(root) && statSync(root).isDirectory(),
    defaultCwd: resolveCwd(undefined),
    catalogFetchedAt: catalog?.fetchedAt ?? null,
  }
}

/** 拆 `provider/modelId`：只按第一个斜杠拆，modelId 本身可以含斜杠。 */
function splitModelRef(ref: string): [string, string] {
  const slash = ref.indexOf('/')
  return slash <= 0 ? ['', ''] : [ref.slice(0, slash), ref.slice(slash + 1)]
}

function modelRef(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`
}

/** 档位收就：与 pi 的 `clampThinkingLevel` 同一顺序（先向上找，再向下找）。 */
const THINKING_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function clampThinking(level: string, supported: readonly string[]): string | null {
  if (!level) return supported[0] ?? null
  if (supported.length === 0 || supported.includes(level)) return level
  const index = THINKING_ORDER.indexOf(level)
  if (index === -1) return supported[0] ?? null
  for (let i = index; i < THINKING_ORDER.length; i += 1) {
    if (supported.includes(THINKING_ORDER[i])) return THINKING_ORDER[i]
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    if (supported.includes(THINKING_ORDER[i])) return THINKING_ORDER[i]
  }
  return supported[0] ?? null
}

// ---------------------------------------------------------------------------
// 扩展 UI 桥接
// ---------------------------------------------------------------------------

/**
 * 扩展的交互请求（确认、选择、输入）转成帧，等浏览器回执。
 *
 * `ExtensionUIContext` 有二十多个成员，TUI 专属能力做成 headless stub（静默丢弃
 * 或降级成通知）；只有对话框类方法需要真正实现。
 *
 * 超时规则：扩展给了正的有限值就取它与服务端上限的较小值，其余（没有、
 * `Infinity`、负数）一律用服务端上限。取消/超时都广播 `extension_ui_closed`，
 * 浏览器据此移除对话框；重连时 `attachChatStream` 会把仍然挂着的请求重发。
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
    const requested = opts?.timeout
    const timeoutMs =
      typeof requested === 'number' && Number.isFinite(requested) && requested > 0
        ? Math.min(requested, UI_TIMEOUT_MS)
        : UI_TIMEOUT_MS
    return new Promise((resolve) => {
      const finish = (value: unknown): void => {
        const pending = chat.uiPending.get(requestId)
        if (!pending) return
        chat.uiPending.delete(requestId)
        clearTimeout(pending.timer)
        if (pending.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort)
        broadcast(chat, { type: 'extension_ui_closed', requestId })
        resolve(value)
      }
      const cancelValue = kind === 'confirm' ? false : undefined
      const timer = setTimeout(() => finish(cancelValue), timeoutMs)
      // 会话级 stop 信号（Esc / abort）与扩展自己的信号任何一个触发都视为取消。
      const signal = opts?.signal
        ? AbortSignal.any([opts.signal, chat.stopController.signal])
        : chat.stopController.signal
      const onAbort = () => finish(cancelValue)
      if (signal.aborted) {
        clearTimeout(timer)
        resolve(cancelValue)
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const frame = { type: 'extension_ui_request', requestId, kind, title, timeoutMs, ...payload }
      chat.uiPending.set(requestId, { kind, frame, resolve: finish, timer, signal, onAbort })
      broadcast(chat, frame)
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
    editor: (title: string, prefill?: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
      request('input', title, { placeholder: prefill ?? '' }, opts) as Promise<string | undefined>,
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
    partialThinking: '',
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
    pendingThinkingDelta: '',
    flushTimer: null,
    stopController: new AbortController(),
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
      chat.partialThinking = ''
      refreshTranscript(chat)
      broadcast(chat, { type: 'agent_settled', aborted: event.aborted === true })
      break
    case 'message_start': {
      // 只有助手消息才重置流式文本：用户消息与工具结果的 message_start
      // 不能把正在流的那段抹掉。
      const message = event.message as { role?: string } | undefined
      const isAssistant = message?.role === 'assistant'
      if (isAssistant) {
        chat.partial = ''
        chat.partialThinking = ''
      }
      broadcast(chat, { type: 'message_start', role: message?.role ?? null })
      break
    }
    case 'message_update': {
      const assistant = event.assistantMessageEvent as
        | { type?: string; delta?: string; contentIndex?: number; [key: string]: unknown }
        | undefined
      if (assistant?.type && typeof assistant.delta === 'string') {
        if (assistant.type === 'text_delta') {
          chat.partial += assistant.delta
          chat.pendingDelta += assistant.delta
        } else if (assistant.type === 'thinking_delta') {
          chat.partialThinking += assistant.delta
          chat.pendingThinkingDelta += assistant.delta
        }
        scheduleDelta(chat)
      }
      // 去掉 `partial`：它每个 delta 都带一遍完整半截消息，文本流会变成 O(n²) 带宽。
      if (assistant) {
        const { partial: _partial, ...framed } = assistant
        broadcast(chat, { type: 'message_update', assistant: framed })
      }
      break
    }
    case 'message_end':
      flushDelta(chat)
      chat.partial = ''
      chat.partialThinking = ''
      refreshTranscript(chat)
      broadcast(chat, { type: 'message_end' })
      break
    case 'turn_end':
      refreshTranscript(chat)
      broadcast(chat, { type: 'turn_end' })
      break
    case 'compaction_end':
      refreshTranscript(chat)
      broadcast(chat, { ...event })
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
      // 工具的 start/update/end 与压缩、重试事件平铺转发：前端要 toolName、
      // toolCallId 与 durationMs，多套一层 `event` 没有意义。
      broadcast(chat, { ...event })
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
  if (chat.pendingDelta) {
    const text = chat.pendingDelta
    chat.pendingDelta = ''
    broadcast(chat, { type: 'delta', text })
  }
  if (chat.pendingThinkingDelta) {
    const text = chat.pendingThinkingDelta
    chat.pendingThinkingDelta = ''
    broadcast(chat, { type: 'thinking_delta', text })
  }
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

export type PromptDisposition = 'started' | 'queued' | 'handled'

/**
 * 发一条消息。只等“是否受理”的预检，不等整轮跑完。
 *
 * SDK 的 `prompt()` 会持续到回合结束；如果 API 也等它，一个长回合会把 HTTP
 * 请求括住几分钟，前端也分不清“提交失败”与“运行中出错”。运行期错误改走 SSE
 * 的 `error` 帧。
 */
export async function promptChat(
  sessionId: string,
  text: string,
  mode?: 'steer' | 'followUp',
): Promise<{ disposition: PromptDisposition }> {
  const chat = requireChat(sessionId)
  const trimmed = text.trim()
  if (!trimmed) throw new HomeError('消息不能为空', 400, 'invalid_request')
  chat.lastActivity = Date.now()

  const accepted = new Promise<{ disposition: PromptDisposition }>((resolve, reject) => {
    const run = chat.session.prompt(trimmed, {
      // 流式期间 SDK 要求显式指定排队方式，缺了会直接抛错。
      ...(chat.session.isStreaming || chat.pendingCount > 0
        ? { streamingBehavior: mode ?? 'followUp' }
        : {}),
      preflightResult: (disposition) => resolve({ disposition }),
    })
    run.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      chat.error = message
      chat.state = 'error'
      broadcast(chat, { type: 'error', message })
      reject(new HomeError(message, 400, 'prompt_failed'))
    })
  })
  return await accepted
}

export async function abortChat(sessionId: string): Promise<{ steering: string[]; followUp: string[] }> {
  const chat = requireChat(sessionId)
  // 先取消挂着等回执的扩展对话框：`session.abort()` 会等空闲，而一个
  // `await ui.confirm()` 的扩展会让“按 Esc”实际卡到超时。
  chat.stopController.abort()
  chat.stopController = new AbortController()
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
  chat.stopController.abort()
  for (const pending of chat.uiPending.values()) {
    clearTimeout(pending.timer)
    pending.resolve(pending.kind === 'confirm' ? false : undefined)
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
  // 首帧回放已落盘内容，第二帧补当前状态（含流式中的半截文本与思考），
  // 然后把仍然挂着的扩展 UI 请求重发一遍：刷新页面不应丢掉确认框。
  send({ type: 'transcript', jsonl: chat.transcript })
  send({ type: 'state', ...publicInfo(chat) })
  for (const pending of chat.uiPending.values()) send(pending.frame)
  chat.subscribers.add(res)

  const ping = setInterval(() => {
    try {
      // 用数据帧而不是 SSE 注释：EventSource 看不到注释，半开连接就检测不到。
      send({ type: 'heartbeat', at: Date.now() })
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
