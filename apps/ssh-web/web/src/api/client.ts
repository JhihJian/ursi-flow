import type { Connection, ConnectionInput, TmuxSessionsResponse } from './types'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(body?.error ?? `API error: ${response.status}`, response.status)
  }
  return (await response.json()) as T
}

export function health(): Promise<string> {
  return request('/health')
}

export function listConnections(): Promise<{ connections: Connection[] }> {
  return request('/connections')
}

export function createConnection(input: ConnectionInput): Promise<{ id: number }> {
  return request('/connections', { method: 'POST', body: JSON.stringify(input) })
}

export function updateConnection(id: number, input: Partial<ConnectionInput>): Promise<{ success: boolean }> {
  return request(`/connections/${id}`, { method: 'PUT', body: JSON.stringify(input) })
}

export function deleteConnection(id: number): Promise<{ success: boolean }> {
  return request(`/connections/${id}`, { method: 'DELETE' })
}

/** 列出远端 tmux 会话；sessions 为 null 表示远端没有 tmux。 */
export function listTmuxSessions(id: number): Promise<TmuxSessionsResponse> {
  return request(`/connections/${id}/tmux-sessions`)
}

/** 终端 WS 地址：tmuxSession 缺省为 ssh-main。 */
export function terminalWsUrl(id: number, tmuxSession?: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const name = tmuxSession ? `?tmux_session=${encodeURIComponent(tmuxSession)}` : ''
  return `${protocol}://${window.location.host}/api/connections/${id}/terminal${name}`
}
