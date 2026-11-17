/** HTTP 错误只保留状态码和固定提示，原始响应可能包含敏感信息。 */
export class ApiError extends Error {
  constructor(public readonly status: number, message = '请求失败，请稍后重试。') {
    super(message)
    this.name = 'ApiError'
  }
}

/** 返回原始 JSON 结构，不假定业务响应包络。204 返回 undefined。 */
export async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T | undefined> {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError('API 路径必须以单个 / 开头。')
  }
  const headers = new Headers(options.headers)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
  })
  if (!response.ok) throw new ApiError(response.status)
  if (response.status === 204) return undefined
  const contentType = response.headers.get('content-type') ?? ''
  if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(contentType)) {
    throw new ApiError(response.status, '服务返回了非 JSON 数据。')
  }
  try {
    return await response.json() as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(response.status, '服务返回了无法读取的数据。')
  }
}
