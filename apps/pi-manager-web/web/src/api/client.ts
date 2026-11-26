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
  LiveSessionsListing,
  McpListing,
  ModelCatalog,
  ModelsListing,
  MutationResult,
  PluginsListing,
  ProbeResult,
  DiscoveryResult,
  SkillContent,
  SkillsListing,
  SessionTaskListing,
  SessionDisk,
  ChatInfo,
  ChatListing,
  ChatOptions,
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

export type * from './types'

/** 建一个指向某前缀的客户端：独立站点不传 base，工作台模块传 `/api/pi-manager`。 */
export function createApiClient(base: string | (() => string) = '') {
  return {
  homeDefaults: () => {
    const url = new URL(apiUrl(base, '/api/home/defaults'), window.location.origin)
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
  homeCheck: (home: string) => request<HomeCheck>(base, 'GET', '/api/home/check', home),
  /** pi home 清单：注册表条目 + 自动发现（默认位置、env、同机其他用户）。 */
  getHomes: () => requestNoHome<HomesListing>(base, 'GET', '/api/homes'),
  createHome: (input: HomeCreateInput) =>
    requestNoHome<{ home: HomeSummary }>(base, 'POST', '/api/homes', input),
  updateHome: (id: string, patch: { name?: string; description?: string }) =>
    requestNoHome<{ home: HomeSummary }>(base, 'PATCH', '/api/homes', { id, ...patch }),
  removeHome: (id: string) => requestNoHome<{ ok: true }>(base, 'DELETE', '/api/homes', { id }),
  getGeneral: (home: string) => request<GeneralListing>(base, 'GET', '/api/general', home),
  putGeneralKey: (home: string, key: string, value: unknown, revision: string) =>
    request<MutationResult>(base, 'PUT', '/api/general/key', home, { key, value, revision }),
  /** 内置工具开关：服务端按 pi 的 +/- 修饰语义写回 defaultTools。 */
  putGeneralTools: (home: string, builtinTools: string[], revision: string) =>
    request<MutationResult>(base, 'PUT', '/api/general/tools', home, { builtinTools, revision }),
  /** Windows：PowerShell 代替 bash（服务端写普通名字工具集）。 */
  putGeneralShell: (home: string, powerShell: boolean, revision: string) =>
    request<MutationResult>(base, 'PUT', '/api/general/shell', home, { powerShell, revision }),
  /** 默认模型同时由 defaultProvider 与 defaultModel 两个 key 组成，必须一次写完。 */
  putGeneralModel: (home: string, provider: string, modelId: string, revision: string) =>
    request<MutationResult>(base, 'PUT', '/api/general/model', home, { provider, modelId, revision }),
  getSkills: (home: string) => request<SkillsListing>(base, 'GET', '/api/skills', home),
  /** 单个 skill 的完整内容：frontmatter 原条目 + 正文。 */
  getSkillContent: (home: string, relDir: string) =>
    request<SkillContent>(base, 'GET', `/api/skills/content?relDir=${encodeURIComponent(relDir)}`, home),
  toggleSkill: (home: string, relDir: string, disabled: boolean) =>
    request<{ ok: true; disabled: boolean }>(base, 'POST', '/api/skills/toggle', home, { relDir, disabled }),
  getAgents: (home: string) => request<AgentsListing>(base, 'GET', '/api/agents', home),
  getAgentProfile: (home: string, file: string) =>
    request<AgentProfile>(base, 'GET', `/api/agents/profile?file=${encodeURIComponent(file)}`, home),
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
  ) => request<MutationResult & { file: string; profile: AgentProfile }>(base, 'PUT', '/api/agents/profile', home, payload),
  deleteAgentProfile: (home: string, file: string) =>
    request<{ ok: true }>(base, 'DELETE', '/api/agents/profile', home, { file }),
  putAgentsSettings: (
    home: string,
    payload: { builtInEnabled: boolean; disabledBuiltIns: string[]; maxConcurrent: number | null; revision: string },
  ) =>
    request<MutationResult & { settings: AgentsListing['settings'] }>(base, 'PUT', '/api/agents/settings', home, payload),
  getMcp: (home: string) => request<McpListing>(base, 'GET', '/api/mcp', home),
  putMcpServers: (home: string, servers: Record<string, Record<string, unknown> | null>, revision: string) =>
    request<MutationResult>(base, 'PUT', '/api/mcp/servers', home, { servers, revision }),
  /** 只改一个 server 的 enabled / exposure。 */
  putMcpServerState: (
    home: string,
    name: string,
    patch: { enabled?: boolean; exposure?: 'direct' | 'deferred' | 'codemode' },
    revision: string,
  ) => request<MutationResult>(base, 'PUT', '/api/mcp/server', home, { name, ...patch, revision }),
  getModels: (home: string) => request<ModelsListing>(base, 'GET', '/api/models', home),
  getModelCatalog: (home: string) => request<ModelCatalog>(base, 'GET', '/api/models/catalog', home),
  /** 重新采集运行时模型目录（会加载该 home 的扩展，只在用户点刷新时调用）。 */
  refreshModelCatalog: (home: string) => request<ModelCatalog>(base, 'POST', '/api/models/catalog/refresh', home),
  putModelProviders: (home: string, providers: Record<string, Record<string, unknown> | null>, revision: string) =>
    request<MutationResult>(base, 'PUT', '/api/models/providers', home, { providers, revision }),
  /** 测一个草稿模型（会发一次真实请求，凭据来自该 home 的 auth.json）。 */
  testModel: (home: string, providerName: string, provider: Record<string, unknown>, model: Record<string, unknown>) =>
    request<ProbeResult>(base, 'POST', '/api/models/test', home, { providerName, provider, model }),
  /** 拉取上游 /models 列表（不写文件）。 */
  discoverModels: (home: string, providerName: string, provider: Record<string, unknown>) =>
    request<DiscoveryResult>(base, 'POST', '/api/models/discover', home, { providerName, provider }),
  /** 写单个模型的 modelOverrides（null 表示删除覆盖），只改 models.json 的这一个键。 */
  putModelOverride: (
    home: string,
    provider: string,
    modelId: string,
    override: Record<string, unknown> | null,
    revision: string,
  ) =>
    request<MutationResult>(base, 'PUT', '/api/models/override', home, { provider, modelId, override, revision }),
  getAuth: (home: string) => request<AuthListing>(base, 'GET', '/api/auth', home),
  /** 合并写回 auth.json 条目：只改提交里出现的 provider，null 删除条目。 */
  putAuthEntries: (
    home: string,
    entries: Record<string, Record<string, unknown> | null>,
    revision: string,
  ) => request<MutationResult>(base, 'PUT', '/api/auth/entries', home, { entries, revision }),
  getPlugins: (home: string) => request<PluginsListing>(base, 'GET', '/api/plugins', home),
  /** 该 home 的跨进程运行态：读心跳扩展写的文件。 */
  getLiveSessions: (home: string) => request<LiveSessionsListing>(base, 'GET', '/api/session/live', home),
  mutatePluginEntry: (home: string, action: 'enable' | 'disable' | 'remove', index: number, revision: string) =>
    request<MutationResult>(base, 'POST', '/api/plugins/entry', home, { action, index, revision }),

  // ---- 会话与任务（给会话模块和任务分区用） ----
  getSessionTasks: (home: string) =>
    requestNoHome<SessionTaskListing>(base, 'GET', `/api/session/tasks?home=${encodeURIComponent(home)}`),
  getSessionDisk: (home: string) =>
    requestNoHome<SessionDisk>(base, 'GET', `/api/session/disk?home=${encodeURIComponent(home)}`),
  cancelSessionTask: (sessionId: string) =>
    requestNoHome<{ ok: true }>(base, 'POST', '/api/session/cancel', { sessionId }),
  /** 跨 home 的运行态：会话模块按会话文件绝对路径匹配。 */
  getLiveFeed: () => requestNoHome<LiveSessionsListing>(base, 'GET', '/api/session/live'),

  // ---- 交互对话运行时 ----
  getChatOptions: (home: string) =>
    requestNoHome<ChatOptions>(base, 'GET', `/api/chat/options?home=${encodeURIComponent(home)}`),
  listChats: (home?: string) =>
    requestNoHome<ChatListing>(base, 
      'GET',
      home ? `/api/chat/sessions?home=${encodeURIComponent(home)}` : '/api/chat/sessions',
    ),
  createChat: (input: ChatCreateInput) => requestNoHome<ChatInfo>(base, 'POST', '/api/chat/session', input),
  getChat: (sessionId: string) =>
    requestNoHome<ChatInfo>(base, 'GET', `/api/chat/session?sessionId=${encodeURIComponent(sessionId)}`),
  promptChat: (sessionId: string, text: string, mode?: 'steer' | 'followUp') =>
    requestNoHome<{ disposition: 'started' | 'queued' | 'handled' }>(base, 'POST', '/api/chat/prompt', {
      sessionId,
      text,
      mode,
    }),
  abortChat: (sessionId: string) =>
    requestNoHome<{ steering: string[]; followUp: string[] }>(base, 'POST', '/api/chat/abort', { sessionId }),
  setChatModel: (sessionId: string, provider: string, modelId?: string, thinkingLevel?: string) =>
    requestNoHome<ChatInfo>(base, 'POST', '/api/chat/model', { sessionId, provider, modelId, thinkingLevel }),
  answerChat: (sessionId: string, requestId: string, value: unknown) =>
    requestNoHome<{ ok: true }>(base, 'POST', '/api/chat/answer', { sessionId, requestId, value }),
  closeChat: (sessionId: string) =>
    requestNoHome<{ ok: true }>(base, 'POST', '/api/chat/close', { sessionId }),
  /** SSE 地址；EventSource 不能带自定义头，因此鉴权只能由部署侧负责。 */
  chatStreamUrl: (sessionId: string) =>
    apiUrl(base, `/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}`),
  }
}

/** 独立入口用的默认实例（同源）；工作台模块通过 configureApiBase 改前缀。 */
export const api = createApiClient(() => defaultBase)
