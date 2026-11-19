import { readToken, setToken } from './session'

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

async function request(version: 'v1' | 'v2', path: string, accept: string, options: RequestInit): Promise<Response> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new TypeError('无效 API 路径')
  const token = readToken()
  if (!token) throw new ApiError(401, '请输入访问令牌。')
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Accept', accept)
  if (options.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(`/api/${version}${path}`, { ...options, headers, redirect: 'error', cache: 'no-store' })
  if (!response.ok) {
    if (response.status === 401 && readToken() === token) setToken('', true)
    const body = await response.json().catch(() => null)
    const detail = body?.error?.message ?? body?.message ?? body?.error
    const reason = (typeof detail === 'string' ? detail : response.statusText).replaceAll(token, '[已隐藏]')
    throw new ApiError(response.status, `HTTP ${response.status}${reason ? `：${reason}` : ''}`)
  }
  return response
}

async function json<T>(version: 'v1' | 'v2', path: string, options: RequestInit): Promise<T> {
  const response = await request(version, path, 'application/json', options)
  if (response.status === 204) return undefined as T
  if (!response.headers.get('content-type')?.includes('json')) throw new Error('服务返回了非 JSON 数据。')
  return response.json() as Promise<T>
}

export function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  return json<T>('v1', path, options)
}

export function requestV2<T>(path: string, options: RequestInit = {}): Promise<T> {
  return json<T>('v2', path, options)
}

export async function requestV2Text(path: string, options: RequestInit = {}): Promise<string> {
  return (await request('v2', path, 'text/plain', options)).text()
}
