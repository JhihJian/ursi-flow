import type {
  HomeCreateInput,
  HomeSummary,
  HomesListing,
  AgentProfile,
  AgentProfileFields,
  AgentsListing,
  AuthListing,
  GeneralListing,
  HomeCheck,
  HomeDefaults,
  McpListing,
  ModelCatalog,
  ModelsListing,
  MutationResult,
  PluginsListing,
  ProbeResult,
  DiscoveryResult,
  SkillContent,
  SkillsListing,
  SessionDisk,
  ChatInfo,
  ChatOptions,
  ChatModelOption,
  ChatCreateInput,
} from './types'

/**
 * 极薄 fetch 封装：所有请求带 ?home=（服务端无全局 home 状态）。
 * 非 2xx 抛 ApiError（保留服务端 code/message）。
 *
 * 接口前缀可注入：独立站点用同源（空前缀），作为工作台模块时传
 * `/api/pi-manager`，由宿主代理转给 8093。
 */

/** 接口前缀：独立入口是空串，工作台模块传 `/api/pi-manager`。 */
function apiUrl(base: string | (() => string), path: string): string {
  const value = typeof base === 'function' ? base() : base
  return `${value.replace(/\/+$/, '')}${path}`
}

/**
 * 默认实例的前缀。配置管理页面都很薄，直接调用 `api`；作为工作台模块时
 * 由模块工厂改一次前缀，避免把 api 传入七个分区组件。
 */
let defaultBase = ''

export function configureApiBase(base: string): void {
  defaultBase = base
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request<T>(base: string | (() => string), method: string, path: string, home: string, body?: unknown): Promise<T> {
  const url = new URL(apiUrl(base, path), window.location.origin)
  url.searchParams.set('home', home)
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON 响应按错误处理 */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`)
  }
  return json as T
}

/** 不携带 home 参数的请求：清单与探测类接口自己解析入参。 */
async function requestNoHome<T >(base: string | (() => string), method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(new URL(apiUrl(base, path), window.location.origin), {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON 响应按错误处理 */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`)
  }
  return json as T
}


/** 服务端会话实体（与 server/src/sessions/registry.ts 的 PiSession 同构）。 */
export interface SessionEntity {
  id: string
  kind: 'chat' | 'task' | 'cli' | 'subagent'
  state: 'discovered' | 'loading' | 'ready' | 'running' | 'failed' | 'evicted'
  persistence: 'memory' | 'file'
  filePath: string | null
  cwd: string
  title: string | null
  parentFile: string | null
  origin: { kind: 'home'; homeId: string; homePath: string } | { kind: 'external'; rootPath: string }
  disk: {
    size: number
    mtime: number
    format: 'pi' | 'legacy' | 'unknown'
    messageCount: number
    firstMessage: string
    createdAt: number
    updatedAt: number
    projectKey: string
    projectName: string
    projectDir: string
  } | null
  runtimes: Array<{
    instanceId: string
    origin: 'local' | 'process'
    host: string
    pid: number
    status: 'idle' | 'running'
    updatedAt: number
  }>
  model: { provider: string; modelId: string; thinkingLevel: string } | null
  queue: number
  interactions: number
  error: { message: string; phase: 'assemble' | 'turn' } | null
  stateSince: number
  seenAt: number
  capabilities?: {
    canLoad: boolean
    canTurn: boolean
    canEvict: boolean
    canDelete: boolean
    canContinue: boolean
    reason?: string
  }
}

export interface RuntimeProfileView {
  homeId: string
  revision: number
  models: {
    candidates: ChatModelOption[]
    default: string | null
    defaultThinkingLevel: string | null
    isScoped: boolean
    scopeWarnings: string[]
    thinkingLevelPins: Record<string, string>
  }
  subagents: string[]
  cwdDefault: string
  sessionsRoot: string
  catalog: { fetchedAt: number | null }
}

export interface SessionsListing {
  epoch: string
  revision: number
  sessions: SessionEntity[]
  notModified?: boolean
  pendingDetails?: number
  truncated?: boolean
}

function toChatOptions(profile: RuntimeProfileView): ChatOptions {
  return {
    models: profile.models.candidates,
    isScoped: profile.models.isScoped,
    scopeWarnings: profile.models.scopeWarnings,
    defaultModel: profile.models.default,
    defaultThinkingLevel: profile.models.defaultThinkingLevel,
    thinkingLevelPins: profile.models.thinkingLevelPins,
    sessionRoot: profile.sessionsRoot,
    sessionRootExists: true,
    defaultCwd: profile.cwdDefault,
    catalogFetchedAt: profile.catalog.fetchedAt,
  }
}

export function toChatInfo(entity: SessionEntity): ChatInfo {
  const local = entity.runtimes.find((fact) => fact.origin === 'local')
  const model = entity.model ? `${entity.model.provider}/${entity.model.modelId}` : null
  return {
    sessionId: entity.id,
    home: entity.origin.kind === 'home' ? entity.origin.homePath : '',
    cwd: entity.cwd,
    model,
    thinkingLevel: entity.model?.thinkingLevel || null,
    sessionFile: entity.filePath,
    name: entity.title,
    state: entity.state === 'running' ? 'running' : entity.state === 'failed' ? 'error' : 'idle',
    isStreaming: local?.status === 'running',
    partial: '',
    partialThinking: '',
    pendingCount: entity.queue,
    error: entity.error?.message ?? null,
    startedAt: entity.stateSince,
    updatedAt: Math.max(entity.seenAt, entity.disk?.updatedAt ?? 0),
  }
}

async function listSessionEntities(
  base: string | (() => string),
  query: { home?: string; root?: string; state?: string; kind?: string },
): Promise<SessionEntity[]> {
  const url = new URL(apiUrl(base, '/api/sessions'), window.location.origin)
  if (query.home) url.searchParams.set('home', query.home)
  if (query.root) url.searchParams.set('root', query.root)
  if (query.state) url.searchParams.set('state', query.state)
  if (query.kind) url.searchParams.set('kind', query.kind)
  const res = await fetch(url)
  const json = (await res.json().catch(() => null)) as SessionsListing | null
  if (!res.ok) throw new ApiError(res.status, 'session_list_failed', `HTTP ${res.status}`)
  return json?.sessions ?? []
}

async function getSessionEntity(base: string | (() => string), sessionId: string): Promise<SessionEntity> {
  const res = await fetch(new URL(apiUrl(base, `/api/sessions/${encodeURIComponent(sessionId)}`), window.location.origin))
  const json = (await res.json().catch(() => null)) as SessionEntity | { error?: { message?: string } } | null
  if (!res.ok) {
    const message = (json as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`
    throw new ApiError(res.status, 'session_absent', message)
  }
  return json as SessionEntity
}

export type * from './types'

/** 建一个指向某前缀的客户端：独立站点不传 base，工作台模块传 `/api/pi-manager`。 */
export function createApiClient(base: string | (() => string) = '') {
  return {
  homeDefaults: () => {
    const url = new URL(apiUrl(base, '/api/homes/defaults'), window.location.origin)
    return fetch(url).then(async (res) => {
      const text = await res.text()
      const json = text ? (JSON.parse(text) as unknown) : null
      if (!res.ok) {
        const err = (json as { error?: { code?: string; message?: string } } | null)?.error
        throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`)
      }
      return json as HomeDefaults
    })
  },
  homeCheck: (home: string) => request<HomeCheck>(base, 'GET', '/api/homes/check', home),
  /** pi home 清单：注册表条目 + 自动发现（默认位置、env、同机其他用户）。 */
  getHomes: () => requestNoHome<HomesListing>(base, 'GET', '/api/homes'),
  createHome: (input: HomeCreateInput) =>
    requestNoHome<{ home: HomeSummary }>(base, 'POST', '/api/homes', input),
  updateHome: (id: string, patch: { name?: string; description?: string }) =>
    requestNoHome<{ home: HomeSummary }>(base, 'PATCH', '/api/homes', { id, ...patch }),
  removeHome: (id: string) => requestNoHome<{ ok: true }>(base, 'DELETE', '/api/homes', { id }),
  getGeneral: (home: string) => request<GeneralListing>(base, 'GET', '/api/config/general', home),
  putGeneralKey: (home: string, key: string, value: unknown, revision: string) =>
    request<MutationResult>(base, 'PUT', '/api/config/general/key', home, { key, value, revision }),
  /** 内置工具开关：服务端按 pi 的 +/- 修饰语义写回 defaultTools。 */
  putGeneralTools: (home: string, builtinTools: string[], revision: string) =>
    request<MutationResult>(base, 'PUT', '/api/config/general/tools', home, { builtinTools, revision }),
  /** Windows：PowerShell 代替 bash（服务端写普通名字工具集）。 */
  putGeneralShell: (home: string, powerShell: boolean, revision: string) =>
    request<MutationResult>(base, 'PUT', '/api/config/general/shell', home, { powerShell, revision }),
  /** 默认模型同时由 defaultProvider 与 defaultModel 两个 key 组成，必须一次写完。 */
  putGeneralModel: (home: string, provider: string, modelId: string, revision: string) =>
    request<MutationResult>(base, 'PUT', '/api/config/general/model', home, { provider, modelId, revision }),
  getSkills: (home: string) => request<SkillsListing>(base, 'GET', '/api/config/skills', home),
  /** 单个 skill 的完整内容：frontmatter 原条目 + 正文。 */
  getSkillContent: (home: string, relDir: string) =>
    request<SkillContent>(base, 'GET', `/api/config/skills/content?relDir=${encodeURIComponent(relDir)}`, home),
  toggleSkill: (home: string, relDir: string, disabled: boolean) =>
    request<{ ok: true; disabled: boolean }>(base, 'POST', '/api/config/skills/toggle', home, { relDir, disabled }),
  getAgents: (home: string) => request<AgentsListing>(base, 'GET', '/api/config/agents', home),
  getAgentProfile: (home: string, file: string) =>
    request<AgentProfile>(base, 'GET', `/api/config/agents/profile?file=${encodeURIComponent(file)}`, home),
  putAgentProfile: (
    home: string,
    payload: {
      file: string
      name: string
      description: string
      fields: AgentProfileFields
      presentKeys: string[]
      extraKeys: string[]
      body: string
      revision: string
    },
  ) => request<MutationResult & { file: string; profile: AgentProfile }>(base, 'PUT', '/api/config/agents/profile', home, payload),
  deleteAgentProfile: (home: string, file: string) =>
    request<{ ok: true }>(base, 'DELETE', '/api/config/agents/profile', home, { file }),
  putAgentsSettings: (
    home: string,
    payload: { builtInEnabled: boolean; disabledBuiltIns: string[]; maxConcurrent: number | null; revision: string },
  ) =>
    request<MutationResult & { settings: AgentsListing['settings'] }>(base, 'PUT', '/api/config/agents/settings', home, payload),
  getMcp: (home: string) => request<McpListing>(base, 'GET', '/api/config/mcp', home),
  putMcpServers: (home: string, servers: Record<string, Record<string, unknown> | null>, revision: string) =>
    request<MutationResult>(base, 'PUT', '/api/config/mcp/servers', home, { servers, revision }),
  /** 只改一个 server 的 enabled / exposure。 */
  putMcpServerState: (
    home: string,
    name: string,
    patch: { enabled?: boolean; exposure?: 'direct' | 'deferred' | 'codemode' },
    revision: string,
  ) => request<MutationResult>(base, 'PUT', '/api/config/mcp/server', home, { name, ...patch, revision }),
  getModels: (home: string) => request<ModelsListing>(base, 'GET', '/api/config/models', home),
  getModelCatalog: (home: string) => request<ModelCatalog>(base, 'GET', '/api/config/models/catalog', home),
  /** 重新采集运行时模型目录（会加载该 home 的扩展，只在用户点刷新时调用）。 */
  refreshModelCatalog: (home: string) => request<ModelCatalog>(base, 'POST', '/api/config/models/catalog/refresh', home),
  putModelProviders: (home: string, providers: Record<string, Record<string, unknown> | null>, revision: string) =>
    request<MutationResult>(base, 'PUT', '/api/config/models/providers', home, { providers, revision }),
  /** 测一个草稿模型（会发一次真实请求，凭据来自该 home 的 auth.json）。 */
  testModel: (home: string, providerName: string, provider: Record<string, unknown>, model: Record<string, unknown>) =>
    request<ProbeResult>(base, 'POST', '/api/config/models/test', home, { providerName, provider, model }),
  /** 拉取上游 /models 列表（不写文件）。 */
  discoverModels: (home: string, providerName: string, provider: Record<string, unknown>) =>
    request<DiscoveryResult>(base, 'POST', '/api/config/models/discover', home, { providerName, provider }),
  /** 写单个模型的 modelOverrides（null 表示删除覆盖），只改 models.json 的这一个键。 */
  putModelOverride: (
    home: string,
    provider: string,
    modelId: string,
    override: Record<string, unknown> | null,
    revision: string,
  ) =>
    request<MutationResult>(base, 'PUT', '/api/config/models/override', home, { provider, modelId, override, revision }),
  getAuth: (home: string) => request<AuthListing>(base, 'GET', '/api/config/auth', home),
  /** 合并写回 auth.json 条目：只改提交里出现的 provider，null 删除条目。 */
  putAuthEntries: (
    home: string,
    entries: Record<string, Record<string, unknown> | null>,
    revision: string,
  ) => request<MutationResult>(base, 'PUT', '/api/config/auth/entries', home, { entries, revision }),
  getPlugins: (home: string) => request<PluginsListing>(base, 'GET', '/api/config/plugins', home),
  mutatePluginEntry: (home: string, action: 'enable' | 'disable' | 'remove', index: number, revision: string) =>
    request<MutationResult>(base, 'POST', '/api/config/plugins/entry', home, { action, index, revision }),

  // ---- 会话与任务（给会话模块和任务分区用） ----
  getSessionDisk: async (home: string): Promise<SessionDisk> => {
    const result = await requestNoHome<{ root: string; exists: boolean }>(
      base,
      'GET',
      `/api/sessions/roots?home=${encodeURIComponent(home)}`,
    )
    return { root: result.root, exists: result.exists }
  },
  cancelSessionTask: (sessionId: string) =>
    requestNoHome<{ ok: true }>(base, 'POST', `/api/sessions/${encodeURIComponent(sessionId)}/abort`),

  // ---- 会话实体：对话就是这个实体在运行，不再有独立的 chat 资源 ----

  getChatOptions: async (home: string) => {
    const profile = await requestNoHome<RuntimeProfileView>(
      base,
      'GET',
      `/api/homes/runtime-profile?home=${encodeURIComponent(home)}`,
    )
    return toChatOptions(profile)
  },
  listChats: async (home?: string) => {
    const entities = await listSessionEntities(base, { home, state: 'live', kind: 'chat' })
    const chats = entities.map(toChatInfo)
    return { chats, capacity: { open: chats.length, limit: 0 } }
  },
  createChat: async (input: ChatCreateInput) => {
    const created = await requestNoHome<{ session: SessionEntity | null; chat?: ChatInfo }>(base, 'POST', '/api/sessions', input)
    if (created.chat) return created.chat
    if (!created.session) throw new ApiError(500, 'session_missing', '服务端没有返回会话实体')
    return toChatInfo(created.session)
  },
  getChat: async (sessionId: string) => toChatInfo(await getSessionEntity(base, sessionId)),
  promptChat: async (sessionId: string, text: string, mode?: 'steer' | 'followUp') => {
    const result = await requestNoHome<{ disposition: 'started' | 'queued' | 'handled' }>(
      base,
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/turn`,
      { text, mode },
    )
    return { disposition: result.disposition }
  },
  abortChat: (sessionId: string) =>
    requestNoHome<{ steering: string[]; followUp: string[] }>(
      base,
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/abort`,
    ),
  setChatModel: async (sessionId: string, provider: string, modelId?: string, thinkingLevel?: string) => {
    await requestNoHome<unknown>(base, 'POST', `/api/sessions/${encodeURIComponent(sessionId)}/model`, {
      provider,
      modelId,
      thinkingLevel,
    })
    return toChatInfo(await getSessionEntity(base, sessionId))
  },
  answerChat: (sessionId: string, requestId: string, value: unknown) =>
    requestNoHome<{ ok: true }>(base, 'POST', `/api/sessions/${encodeURIComponent(sessionId)}/interaction`, {
      interactionId: requestId,
      value,
    }),
  closeChat: (sessionId: string) =>
    requestNoHome<{ ok: true }>(base, 'POST', `/api/sessions/${encodeURIComponent(sessionId)}/evict`),
  /** SSE 地址；EventSource 不能带自定义头，因此鉴权只能由部署侧负责。 */
  chatStreamUrl: (sessionId: string) =>
    apiUrl(base, `/api/sessions/${encodeURIComponent(sessionId)}/events`),
  }
}

/** 独立入口用的默认实例（同源）；工作台模块通过 configureApiBase 改前缀。 */
export const api = createApiClient(() => defaultBase)
