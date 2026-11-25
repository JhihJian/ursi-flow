import type { Connection, ConnectionInput, TmuxSessionsResponse } from './types'

/** 虚拟本机连接：与服务端约定一致，id 0、不入库、不可改删。 */
export const LOCAL_CONNECTION_ID = 0
export const LOCAL_CONNECTION_NAME = '本机'

function localConnection(): Connection {
  return {
    id: LOCAL_CONNECTION_ID,
    name: LOCAL_CONNECTION_NAME,
    command: '登录 shell',
    kind: 'local',
    created_at: '',
    updated_at: '',
  }
}

export interface SshApiOptions {
  /** API 前缀。缺省 `/api`（独立入口的同源代理）；嵌入工作区时由宿主注入 `/api/ssh-web`。 */
  baseUrl?: string
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** 一条 API/WS 通道：HTTP 走 baseUrl 前缀，终端 WS 地址由同一前缀推导。 */
export class SshApi {
  readonly baseUrl: string

  constructor(options: SshApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? '/api'
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      throw new ApiError(body?.error ?? `API error: ${response.status}`, response.status)
    }
    return (await response.json()) as T
  }

  health(): Promise<string> {
    return fetch(`${this.baseUrl}/health`).then((response) => response.text())
  }

  async listConnections(): Promise<{ connections: Connection[] }> {
    const { connections } = await this.request<{ connections: Connection[] }>('/connections')
    // 防御旧版服务端不播种本机连接的情况，前端补齐虚拟本机到首项。
    return {
      connections: connections.some((connection) => connection.name === LOCAL_CONNECTION_NAME)
        ? connections
        : [localConnection(), ...connections.filter((c) => c.id !== LOCAL_CONNECTION_ID)],
    }
  }

  createConnection(input: ConnectionInput): Promise<{ id: number }> {
    return this.request('/connections', { method: 'POST', body: JSON.stringify(input) })
  }

  updateConnection(id: number, input: Partial<ConnectionInput>): Promise<{ success: boolean }> {
    return this.request(`/connections/${id}`, { method: 'PUT', body: JSON.stringify(input) })
  }

  deleteConnection(id: number): Promise<{ success: boolean }> {
    return this.request(`/connections/${id}`, { method: 'DELETE' })
  }

  /** 列出远端 tmux 会话；sessions 为 null 表示远端没有 tmux。 */
  listTmuxSessions(id: number): Promise<TmuxSessionsResponse> {
    return this.request(`/connections/${id}/tmux-sessions`)
  }

  /** 终端 WS 地址：tmuxSession 缺省为 ssh-main，cols/rows 为面板初始尺寸。 */
  terminalWsUrl(id: number, tmuxSession: string | undefined, cols: number, rows: number): string {
    const params = new URLSearchParams()
    if (tmuxSession) params.set('tmux_session', tmuxSession)
    params.set('cols', String(cols))
    params.set('rows', String(rows))
    const query = params.toString()
    const base = this.baseUrl
    if (base.startsWith('http://') || base.startsWith('https://')) {
      const url = new URL(`${base.replace(/\/+$/, '')}/connections/${id}/terminal`)
      url.search = query
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      return url.toString()
    }
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${protocol}://${window.location.host}${base}/connections/${id}/terminal?${query}`
  }
}
