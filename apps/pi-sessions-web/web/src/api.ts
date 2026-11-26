/** 会话目录接口的客户端封装。所有请求都带 `root`，根路径由用户在界面里指定。 */

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
  /** 当前来源能否删除会话、改偏好；局域网访问为 false，界面据此禁用写操作。 */
  canWrite: boolean
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

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new RequestError(body?.error ?? `HTTP ${response.status}`, response.status)
  }
  return (await response.json()) as T
}

const withRoot = (path: string, root: string) =>
  `${path}${path.includes('?') ? '&' : '?'}root=${encodeURIComponent(root)}`

export function fetchConfig(): Promise<ServerConfig> {
  return readJson<ServerConfig>('/api/config')
}

export function fetchSessions(root: string): Promise<Listing> {
  return readJson<Listing>(withRoot('/api/sessions', root))
}

export function fetchDetail(root: string, id: string): Promise<SessionDetail> {
  return readJson<SessionDetail>(withRoot(`/api/sessions/${encodeURIComponent(id)}`, root))
}

export function fetchBrowse(path: string): Promise<BrowseResult> {
  return readJson<BrowseResult>(`/api/browse?path=${encodeURIComponent(path)}`)
}

export const sessionTextUrl = (root: string, id: string) =>
  withRoot(`/api/sessions/${encodeURIComponent(id)}/text`, root)

export function fetchPrefs(): Promise<Prefs> {
  return readJson<Prefs>('/api/prefs')
}

/** 关注或取消关注一个项目；返回更新后的完整列表。 */
export async function updatePrefs(change: { pin?: string; unpin?: string }): Promise<Prefs> {
  const response = await fetch('/api/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(change),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new RequestError(body?.error ?? `HTTP ${response.status}`, response.status)
  }
  return (await response.json()) as Prefs
}

/** 删除会话文件（连带同名 subagent 目录）。只能删当前根目录下的会话。 */
export async function deleteSession(root: string, id: string): Promise<{ id: string; removed: string[] }> {
  const response = await fetch(withRoot(`/api/sessions/${encodeURIComponent(id)}`, root), {
    method: 'DELETE',
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new RequestError(body?.error ?? `HTTP ${response.status}`, response.status)
  }
  return (await response.json()) as { id: string; removed: string[] }
}

export async function fetchSessionText(root: string, id: string): Promise<string> {
  const response = await fetch(sessionTextUrl(root, id))
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new RequestError(body?.error ?? `HTTP ${response.status}`, response.status)
  }
  return response.text()
}
