/**
 * 会话目录接口的客户端封装。所有请求都带 `root`，根路径由用户在界面里指定。
 *
 * 接口前缀由宿主注入（嵌入工作区时是 /api/pi-sessions，独立入口是 /api），
 * 因此这里导出工厂而不是写死路径的函数。
 */

export type SessionFormat = 'pi' | 'legacy' | 'unknown'

export interface SessionRow {
  id: string
  path: string
  projectDir: string
  projectKey: string
  projectName: string
  cwd: string
  name?: string
  firstMessage: string
  messageCount: number
  created: number
  modified: number
  size: number
  format: SessionFormat
  /** 只有头部元信息，消息数与首条消息还在后台补 */
  detailsPending: boolean
}

export interface Listing {
  root: string
  sessions: SessionRow[]
  pendingDetails: number
  truncated: boolean
}

export interface SessionDetail extends SessionRow {
  tooLarge: boolean
}

export interface BrowseEntry {
  name: string
  path: string
  sessions: number
}

export interface BrowseResult {
  path: string
  parent: string | null
  dirs: BrowseEntry[]
}

export interface ServerConfig {
  defaultRoot: string
  suggestedRoots: string[]
  maxTextBytes: number
}

export interface Prefs {
  /** 特别关注的项目键，顺序即显示顺序。 */
  pinnedProjects: string[]
}

export class RequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'RequestError'
    this.status = status
  }
}

export interface SessionsApi {
  baseUrl: string
  fetchConfig: () => Promise<ServerConfig>
  fetchSessions: (root: string) => Promise<Listing>
  fetchDetail: (root: string, id: string) => Promise<SessionDetail>
  fetchBrowse: (path: string) => Promise<BrowseResult>
  sessionTextUrl: (root: string, id: string) => string
  fetchPrefs: () => Promise<Prefs>
  updatePrefs: (change: { pin?: string; unpin?: string }) => Promise<Prefs>
  deleteSession: (root: string, id: string) => Promise<{ id: string; removed: string[] }>
  fetchSessionText: (root: string, id: string) => Promise<string>
}

/**
 * 建一个指向某个前缀的客户端。前缀末尾的斜杠会去掉，
 * 这样 `/api/pi-sessions` 与 `/api/pi-sessions/` 得到同一份地址。
 */
export function createSessionsApi(apiBaseUrl = '/api'): SessionsApi {
  const base = apiBaseUrl.replace(/\/+$/, '')
  /** 相对路径 + root 参数；拼前缀的动作只在 readJson / send / fetch 里做一次。 */
  const withRoot = (path: string, root: string) =>
    `${path}${path.includes('?') ? '&' : '?'}root=${encodeURIComponent(root)}`

  async function readJson<T>(path: string): Promise<T> {
    const response = await fetch(`${base}${path}`, { headers: { Accept: 'application/json' } })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      throw new RequestError(body?.error ?? `HTTP ${response.status}`, response.status)
    }
    return (await response.json()) as T
  }

  async function send<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${base}${path}`, init)
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      throw new RequestError(body?.error ?? `HTTP ${response.status}`, response.status)
    }
    return (await response.json()) as T
  }

  const sessionTextUrl = (root: string, id: string) =>
    `${base}${withRoot(`/sessions/${encodeURIComponent(id)}/text`, root)}`

  return {
    baseUrl: base,
    fetchConfig: () => readJson<ServerConfig>('/config'),
    fetchSessions: (root) => readJson<Listing>(withRoot('/sessions', root)),
    fetchDetail: (root, id) =>
      readJson<SessionDetail>(withRoot(`/sessions/${encodeURIComponent(id)}`, root)),
    fetchBrowse: (path) => readJson<BrowseResult>(`/browse?path=${encodeURIComponent(path)}`),
    sessionTextUrl,
    fetchPrefs: () => readJson<Prefs>('/prefs'),
    updatePrefs: (change) =>
      send<Prefs>('/prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      }),
    deleteSession: (root, id) =>
      send<{ id: string; removed: string[] }>(
        withRoot(`/sessions/${encodeURIComponent(id)}`, root),
        {
          method: 'DELETE',
        },
      ),
    fetchSessionText: async (root, id) => {
      const response = await fetch(sessionTextUrl(root, id))
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new RequestError(body?.error ?? `HTTP ${response.status}`, response.status)
      }
      return response.text()
    },
  }
}
