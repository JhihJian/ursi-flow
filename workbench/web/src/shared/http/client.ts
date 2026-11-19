import { readToken, setToken } from './session'

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

const textMediaType = 'text/plain'

function httpFailure(status: number, reason: string): ApiError {
  return new ApiError(status, `HTTP ${status}${reason ? `：${reason}` : ''}`)
}

async function request(version: 'v1' | 'v2', path: string, accept: string, options: RequestInit): Promise<Response> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new TypeError('无效 API 路径：只接受同源相对路径。')
  const token = readToken()
  if (!token) throw new ApiError(401, '请输入访问令牌。')
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Accept', accept)
  if (options.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(`/api/${version}${path}`, { ...options, headers, redirect: 'error', cache: 'no-store' })
  if (!response.ok) {
    // 只让当前会话的 401 生效：旧令牌的迟到响应不能注销后来换上的令牌。
    if (response.status === 401 && readToken() === token) setToken('', true)
    const body = await response.json().catch(() => null)
    const detail = body?.error?.message ?? body?.message ?? body?.error
    const reason = (typeof detail === 'string' ? detail : response.statusText).replaceAll(token, '[已隐藏]')
    throw httpFailure(response.status, reason)
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

/** 目录中的文件保留原始字节，也允许空文件。 */
export async function requestV2File(path: string, options: RequestInit = {}): Promise<Blob> {
  const response = await request('v2', path, 'application/octet-stream', options)
  if (response.headers.get('content-type')?.split(';')[0] !== 'application/octet-stream') throw new Error('服务未返回文件内容。')
  return response.blob()
}

/**
 * 读取交付正文。只有 `text/plain` 且非空的响应才算成功：
 * 代理首页（`text/html`）、空正文和 `204` 都按读取失败报告，避免把非交付内容当成验收材料。
 */
export async function requestV2Text(path: string, options: RequestInit = {}): Promise<string> {
  const response = await request('v2', path, textMediaType, options)
  if (response.status === 204) throw httpFailure(204, '交付文件为空，无法读取。')
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (type !== textMediaType) throw httpFailure(response.status, `交付文件必须是纯文本，服务返回了 ${type || '未声明类型'}。`)
  const text = await response.text()
  if (text.trim() === '') throw httpFailure(response.status, '交付文件为空，无法读取。')
  return text
}
