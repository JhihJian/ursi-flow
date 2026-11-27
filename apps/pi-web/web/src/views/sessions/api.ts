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
  /** 集合版本号，下次轮询带上它做未变更快路径。 */
  revision: number
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

/** 服务端会话实体（与 server/src/sessions/registry.ts 的 PiSession 同构）。 */
interface SessionEntity {
  id: string
  state: string
  kind: string
  filePath: string | null
  cwd: string
  title: string | null
  persistence: 'memory' | 'file'
  origin: { kind: 'home'; homeId: string; homePath: string } | { kind: 'external'; rootPath: string }
  disk: {
    size: number
    mtime: number
    format: SessionFormat
    messageCount: number
    firstMessage: string
    createdAt: number
    updatedAt: number
    projectKey: string
    projectName: string
    projectDir: string
  } | null
  runtimes: Array<{ origin: 'local' | 'process'; status: 'idle' | 'running'; host: string; pid: number; updatedAt: number }>
}

/** 实体投影成侧栏要的行：界面不需要知道实体内部结构。 */
function toRow(entity: SessionEntity): SessionRow {
  return {
    id: entity.id,
    path: entity.filePath ?? '',
    projectDir: entity.disk?.projectDir ?? '',
    projectKey: entity.disk?.projectKey ?? entity.cwd,
    projectName: entity.disk?.projectName ?? (entity.cwd ? entity.cwd.split('/').pop() ?? entity.cwd : ''),
    cwd: entity.cwd,
    ...(entity.title ? { name: entity.title } : {}),
    firstMessage: entity.disk?.firstMessage ?? '',
    messageCount: entity.disk?.messageCount ?? 0,
    created: entity.disk?.createdAt ?? 0,
    modified: entity.disk?.updatedAt ?? 0,
    size: entity.disk?.size ?? 0,
    format: entity.disk?.format ?? 'unknown',
    detailsPending: false,
  }
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

/** 错误信封统一为 `{ error: { code, message } }`。 */
async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as
    | { error?: string | { code?: string; message?: string } }
    | null
  const error = body?.error
  if (typeof error === 'string') return error
  return error?.message ?? `HTTP ${response.status}`
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
  /** `since` 等于服务端当前版本时返回 null，表示列表没变、沿用上一份。 */
  fetchSessions: (root: string, since?: number) => Promise<Listing | null>
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
  const withRoot = (path: string, root: string, extra: Record<string, string> = {}) =>
    `${path}${path.includes('?') ? '&' : '?'}root=${encodeURIComponent(root)}${Object.entries(extra)
      .map(([key, value]) => `&${key}=${encodeURIComponent(value)}`)
      .join('')}`

  async function readJson<T>(path: string): Promise<T> {
    const response = await fetch(`${base}${path}`, { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new RequestError(await errorMessage(response), response.status)
    return (await response.json()) as T
  }

  async function send<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${base}${path}`, init)
    if (!response.ok) throw new RequestError(await errorMessage(response), response.status)
    return (await response.json()) as T
  }

  const sessionTextUrl = (root: string, id: string) =>
    `${base}${withRoot(`/api/sessions/${encodeURIComponent(id)}/trajectory`, root)}`

  return {
    baseUrl: base,
    fetchConfig: () => readJson<ServerConfig>('/api/sessions/config'),
    fetchSessions: async (root, since) => {
      const payload = await readJson<{
        revision?: number
        notModified?: boolean
        sessions?: SessionEntity[]
        pendingDetails?: number
        truncated?: boolean
      }>(withRoot('/api/sessions', root, since === undefined ? {} : { since: String(since) }))
      if (payload.notModified) return null
      return {
        root,
        sessions: (payload.sessions ?? []).map(toRow),
        pendingDetails: payload.pendingDetails ?? 0,
        truncated: payload.truncated ?? false,
        revision: payload.revision ?? 0,
      }
    },
    fetchDetail: async (root, id) => {
      const entity = await readJson<SessionEntity>(withRoot(`/api/sessions/${encodeURIComponent(id)}`, root))
      return { ...toRow(entity), tooLarge: (entity.disk?.size ?? 0) > 64 * 1024 * 1024 }
    },
    fetchBrowse: (path) => readJson<BrowseResult>(`/api/sessions/browse?path=${encodeURIComponent(path)}`),
    sessionTextUrl,
    fetchPrefs: () => readJson<Prefs>('/api/sessions/prefs'),
    updatePrefs: (change) =>
      send<Prefs>('/api/sessions/prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      }),
    deleteSession: (root, id) =>
      send<{ id: string; removed: string[] }>(
        withRoot(`/api/sessions/${encodeURIComponent(id)}`, root),
        {
          method: 'DELETE',
        },
      ),
    fetchSessionText: async (root, id) => {
      const response = await fetch(sessionTextUrl(root, id))
      if (!response.ok) throw new RequestError(await errorMessage(response), response.status)
      return response.text()
    },
  }
}
