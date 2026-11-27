import type {
  Connection,
  ConnectionInput,
  DiscoveredHost,
  HostMetrics,
  ImportConnectionsResponse,
  TestConnectionResponse,
  TmuxSessionsResponse,
} from './types'

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

  listConnections(): Promise<{ connections: Connection[] }> {
    return this.request('/connections')
  }

  createConnection(input: ConnectionInput): Promise<{ id: number }> {
    return this.request('/connections', { method: 'POST', body: JSON.stringify(input) })
  }

  /** 自检一条尚未保存的 ssh 命令：只验证能否连上，不读远端 tmux。 */
  testConnection(command: string): Promise<TestConnectionResponse> {
    return this.request('/connections/test', { method: 'POST', body: JSON.stringify({ command }) })
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

  /** 移除远端 tmux 会话（kill-session，其中进程一并结束）。 */
  killTmuxSession(id: number, session: string): Promise<{ success: boolean }> {
    return this.request(`/connections/${id}/tmux-sessions/${encodeURIComponent(session)}`, {
      method: 'DELETE',
    })
  }

  /** 采样远端设备资源。每次请求由服务端跑一轮独立的批量 ssh。 */
  getMetrics(id: number): Promise<HostMetrics> {
    return this.request(`/connections/${id}/metrics`)
  }

  /** 从本机 ssh config 发现可批量导入的主机（ssh -G 解析 user/port）。 */
  discoverSshHosts(): Promise<{ hosts: DiscoveredHost[] }> {
    return this.request('/ssh-config/hosts')
  }

  /** 批量导入连接；单条失败不阻断其余，失败明细在响应里。 */
  importConnections(inputs: ConnectionInput[]): Promise<ImportConnectionsResponse> {
    return this.request('/connections/import', {
      method: 'POST',
      body: JSON.stringify({ connections: inputs }),
    })
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
