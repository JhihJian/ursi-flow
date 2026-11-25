import type { ApiError, EntryDto, GitBranchesDto, GitStatusDto, WorkspaceInfo } from '../../server/src/types.ts'

export type { ApiError, EntryDto, GitBranchesDto, GitStatusDto, WorkspaceInfo }
export type { GitChangeDto } from '../../server/src/types.ts'

/** 统一错误：code 与服务端 ApiError 对齐，组件按 code 分支。 */
export class ApiClientError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

interface ReadResult {
  content: string
  mtime: number
  size: number
}

interface WriteResult {
  mtime: number
}

/**
 * HTTP 客户端。apiBaseUrl 由宿主注入（模块契约第 6 条），缺省走开发代理。
 * 除 workspaces 外一律 POST + JSON，path 用 segments 数组。
 */
export class WorkspaceApi {
  constructor(readonly baseUrl: string) {}

  private async post<T>(route: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json: unknown = await res.json().catch(() => ({ code: 'io', message: `响应不是 JSON（${res.status}）` }))
    if (!res.ok) {
      const apiError = json as ApiError
      throw new ApiClientError(apiError.code ?? 'io', res.status, apiError.message ?? `请求失败（${res.status}）`)
    }
    return json as T
  }

  async workspaces(): Promise<WorkspaceInfo[]> {
    const res = await fetch(`${this.baseUrl}/workspaces`, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new ApiClientError('io', res.status, `workspace 列表请求失败（${res.status}）`)
    return (await res.json()) as WorkspaceInfo[]
  }

  list(workspaceId: string, path: string[]): Promise<{ entries: EntryDto[] }> {
    return this.post('list', { workspaceId, path })
  }

  read(workspaceId: string, path: string[]): Promise<ReadResult> {
    return this.post('read', { workspaceId, path })
  }

  write(
    workspaceId: string,
    path: string[],
    content: string,
    options: { expectMtime?: number; overwrite?: boolean } = {},
  ): Promise<WriteResult> {
    return this.post('write', { workspaceId, path, content, ...options })
  }

  mkdir(workspaceId: string, path: string[]): Promise<EntryDto> {
    return this.post('mkdir', { workspaceId, path })
  }

  rename(workspaceId: string, path: string[], newName: string): Promise<EntryDto> {
    return this.post('rename', { workspaceId, path, newName })
  }

  delete(workspaceId: string, path: string[]): Promise<{ ok: true }> {
    return this.post('delete', { workspaceId, path })
  }

  gitStatus(workspaceId: string): Promise<GitStatusDto> {
    return this.post('git-status', { workspaceId })
  }

  /** 推送当前分支到 upstream。 */
  gitPush(workspaceId: string): Promise<{ ok: true }> {
    return this.post('git-push', { workspaceId })
  }

  /** 拉取并快进当前分支；分叉或冲突时抛错。 */
  gitPull(workspaceId: string): Promise<{ ok: true }> {
    return this.post('git-pull', { workspaceId })
  }

  /** 分支与远端分支树。 */
  gitBranches(workspaceId: string): Promise<GitBranchesDto> {
    return this.post('git-branches', { workspaceId })
  }

  /** 运行时添加目录：服务端 realpath 探活后返回完整 WorkspaceInfo。 */
  addWorkspace(root: string): Promise<WorkspaceInfo> {
    return this.post('workspaces-add', { root })
  }

  /** label 与 description 至少一项；都传则同时更新。 */
  renameWorkspace(
    workspaceId: string,
    fields: { label?: string; description?: string },
  ): Promise<WorkspaceInfo> {
    return this.post('workspaces-rename', { workspaceId, ...fields })
  }

  removeWorkspace(workspaceId: string): Promise<{ ok: true }> {
    return this.post('workspaces-remove', { workspaceId })
  }
}

/** 键：JSON 编码的 [workspaceId, ...segments]。文件名可含任意可见字符，JSON 编码无歧义且可逆。 */
export type FileKey = string

export function makeKey(workspaceId: string, segments: string[]): FileKey {
  return JSON.stringify([workspaceId, ...segments])
}

export function keyToParent(key: FileKey): { parentKey: FileKey; name: string } | null {
  const parts = JSON.parse(key) as string[]
  if (parts.length < 2) return null
  return { parentKey: JSON.stringify(parts.slice(0, -1)), name: parts[parts.length - 1]! }
}

export function keyToWorkspaceId(key: FileKey): string {
  return (JSON.parse(key) as string[])[0]!
}

export function keyAppend(key: FileKey, name: string): FileKey {
  return JSON.stringify([...(JSON.parse(key) as string[]), name])
}

export function keySegments(key: FileKey): { workspaceId: string; path: string[] } {
  const parts = JSON.parse(key) as string[]
  return { workspaceId: parts[0]!, path: parts.slice(1) }
}

export function keyName(key: FileKey): string {
  const parts = JSON.parse(key) as string[]
  return parts[parts.length - 1] ?? parts[0]!
}
