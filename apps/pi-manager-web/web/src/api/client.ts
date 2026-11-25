import type {
  HomesListing,
  AgentProfileDetail,
  AgentsListing,
  AuthListing,
  GeneralListing,
  HomeCheck,
  HomeDefaults,
  McpListing,
  ModelsListing,
  MutationResult,
  PluginsListing,
  SkillsListing,
} from './types'

/**
 * 极薄 fetch 封装：所有请求带 ?home=（服务端无全局 home 状态）。
 * 非 2xx 抛 ApiError（保留服务端 code/message）。
 */

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request<T>(method: string, path: string, home: string, body?: unknown): Promise<T> {
  const url = new URL(path, window.location.origin)
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

export const api = {
  homeDefaults: () => {
    const url = new URL('/api/home/defaults', window.location.origin)
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
  homeCheck: (home: string) => request<HomeCheck>('GET', '/api/home/check', home),
  /** 已知 pi home：服务端扫描默认位置、env 位置、同机其他用户，外加前端登记的预设。 */
  getHomes: (extra: string[]) => {
    const url = new URL('/api/homes', window.location.origin)
    for (const path of extra) url.searchParams.append('extra', path)
    return fetch(url).then(async (res) => {
      const text = await res.text()
      const json = text ? (JSON.parse(text) as unknown) : null
      if (!res.ok) {
        const err = (json as { error?: { code?: string; message?: string } } | null)?.error
        throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`)
      }
      return json as HomesListing
    })
  },
  getGeneral: (home: string) => request<GeneralListing>('GET', '/api/general', home),
  putGeneralKey: (home: string, key: string, value: unknown, revision: string) =>
    request<MutationResult>('PUT', '/api/general/key', home, { key, value, revision }),
  getSkills: (home: string) => request<SkillsListing>('GET', '/api/skills', home),
  toggleSkill: (home: string, relDir: string, disabled: boolean) =>
    request<{ ok: true; disabled: boolean }>('POST', '/api/skills/toggle', home, { relDir, disabled }),
  getAgents: (home: string) => request<AgentsListing>('GET', '/api/agents', home),
  getAgentProfile: (home: string, file: string) =>
    request<AgentProfileDetail>('GET', `/api/agents/profile?file=${encodeURIComponent(file)}`, home),
  putAgentProfile: (
    home: string,
    payload: { file: string; name: string; description: string; extraKeys: string[]; body: string; revision: string },
  ) => request<MutationResult & { file: string }>('PUT', '/api/agents/profile', home, payload),
  deleteAgentProfile: (home: string, file: string) =>
    request<{ ok: true }>('DELETE', '/api/agents/profile', home, { file }),
  putAgentsSettings: (
    home: string,
    payload: { builtInEnabled: boolean; disabledBuiltIns: string[]; maxConcurrent: number | null; revision: string },
  ) =>
    request<MutationResult & { settings: AgentsListing['settings'] }>('PUT', '/api/agents/settings', home, payload),
  getMcp: (home: string) => request<McpListing>('GET', '/api/mcp', home),
  putMcpServers: (home: string, servers: Record<string, Record<string, unknown> | null>, revision: string) =>
    request<MutationResult>('PUT', '/api/mcp/servers', home, { servers, revision }),
  getModels: (home: string) => request<ModelsListing>('GET', '/api/models', home),
  putModelProviders: (home: string, providers: Record<string, Record<string, unknown> | null>, revision: string) =>
    request<MutationResult>('PUT', '/api/models/providers', home, { providers, revision }),
  getAuth: (home: string) => request<AuthListing>('GET', '/api/auth', home),
  /** 合并写回 auth.json 条目：只改提交里出现的 provider，null 删除条目。 */
  putAuthEntries: (
    home: string,
    entries: Record<string, Record<string, unknown> | null>,
    revision: string,
  ) => request<MutationResult>('PUT', '/api/auth/entries', home, { entries, revision }),
  getPlugins: (home: string) => request<PluginsListing>('GET', '/api/plugins', home),
  mutatePluginEntry: (home: string, action: 'enable' | 'disable' | 'remove', index: number, revision: string) =>
    request<MutationResult>('POST', '/api/plugins/entry', home, { action, index, revision }),
}
