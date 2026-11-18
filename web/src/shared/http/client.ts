import { readToken, setToken } from './session'

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

/** Runtime responds with the result itself, not a data envelope. */
export async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new TypeError('无效 API 路径')
  const token = readToken()
  if (!token) throw new ApiError(401, '请输入访问令牌。')
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Accept', 'application/json')
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')
  const response = await fetch(`/api/v1${path}`, { ...options, headers, redirect: 'error', cache: 'no-store' })
  if (!response.ok) {
    if (response.status === 401 && readToken() === token) setToken('', true)
    const body = await response.json().catch(() => null)
    const detail = body?.error?.message ?? body?.message ?? body?.error
    const reason = typeof detail === 'string' ? detail.replaceAll(token, '[已隐藏]') : response.statusText
    throw new ApiError(response.status, `HTTP ${response.status}${reason ? `：${reason}` : ''}`)
  }
  if (response.status === 204) return undefined as T
  if (!response.headers.get('content-type')?.includes('json')) throw new Error('服务返回了非 JSON 数据。')
  return response.json() as Promise<T>
}
