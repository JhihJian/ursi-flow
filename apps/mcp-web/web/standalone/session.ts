import type { McpRequest } from '../src/client'
import { errorMessage } from '../src/lib/error'

const storageKey = 'mcp-web:access-token'

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function send<T>(token: string, path: string, options: RequestInit, unauthorized?: () => void): Promise<T> {
  let response: Response
  try {
    const headers = new Headers({ Accept: 'application/json', Authorization: `Bearer ${token}` })
    if (options.body != null) headers.set('Content-Type', 'application/json')
    response = await fetch(`/api/v2${path}`, {
      ...options, headers, method: options.method ?? 'GET',
      mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error',
    })
  } catch (cause) {
    if (options.signal?.aborted) throw cause
    throw new Error('请求未能发送或连接中断，请检查网络后重试。')
  }
  if (response.status === 401) unauthorized?.()
  const body: { error?: unknown } | undefined = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = body?.error
    throw new ApiError(response.status, typeof message === 'string' && message.trim() ? message : `请求失败（HTTP ${response.status}）。`)
  }
  if (body === undefined) throw new Error('服务器未返回有效的 JSON。')
  return body as T
}

function readToken(): string | null {
  try { return sessionStorage.getItem(storageKey) } catch { return null }
}

function storeToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(storageKey, token)
    else sessionStorage.removeItem(storageKey)
  } catch {
    // Storage can be blocked by the browser. The session still works in memory.
  }
}

type Session = { token: string | null; checking: boolean; message: string }
let session: Session = { token: null, checking: !!readToken(), message: '' }
const listeners = new Set<() => void>()

function updateSession(next: Session) {
  session = next
  listeners.forEach(listener => listener())
}

export function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const getSession = () => session

export function signOut(message = '') {
  storeToken(null)
  updateSession({ token: null, checking: false, message })
}

export async function signIn(token: string, signal?: AbortSignal) {
  const servers = await send<unknown>(token, '/mcp-servers', { signal })
  if (!Array.isArray(servers)) throw new Error('服务器未返回有效的服务列表。')
  signal?.throwIfAborted()
  storeToken(token)
  updateSession({ token, checking: false, message: '' })
}

export async function restoreSession() {
  const token = readToken()
  if (!token) return
  updateSession({ token: null, checking: true, message: '' })
  try {
    await signIn(token)
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) signOut(cause.message)
    else updateSession({ token: null, checking: false, message: errorMessage(cause) })
  }
}

export const request: McpRequest = <T>(path: string, options: RequestInit) => {
  const active = session
  if (!active.token) return Promise.reject(new Error('请先登录。'))
  return send<T>(active.token, path, options, () => {
    // An old request cannot sign out a session opened after it started.
    if (session === active) signOut('会话已失效，请重新登录。')
  })
}
