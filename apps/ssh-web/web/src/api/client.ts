import type { Connection, ConnectionInput, SessionInfo } from './types'

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

export function connectConnection(id: number, cols?: number, rows?: number): Promise<{ session: SessionInfo }> {
  return request(`/connections/${id}/connect`, {
    method: 'POST',
    body: JSON.stringify({ cols, rows }),
  })
}

export function listSessions(): Promise<{ sessions: SessionInfo[] }> {
  return request('/sessions')
}

export function closeSession(id: string): Promise<{ success: boolean }> {
  return request(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
