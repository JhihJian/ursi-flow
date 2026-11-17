let apiTransport: typeof fetch = (...args) => globalThis.fetch(...args)

/** 由应用入口选择演示或网络传输，业务模块始终调用同一个 API 契约。 */
export function setApiTransport(transport: typeof fetch) { apiTransport = transport }

const messages: Record<string, string> = {
  VALIDATION: '配置校验失败，请检查必填字段、地址和凭据引用。',
  REFERENCE_CONFLICT: '此资源仍被其他配置引用，请先解除引用后再删除。',
  INVALID_STATE: '当前状态不允许此操作，请刷新后重试。',
  NOT_FOUND: '请求的记录不存在或已被删除。',
  SERVICE_UNAVAILABLE: '服务暂时不可用，请重试。',
  INVALID_WORKFLOW: '流程定义不合法，请检查节点、连线和角色引用。',
}

/** HTTP 错误只保留状态码和白名单提示，原始响应可能包含敏感信息。 */
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
  const response = await apiTransport(`/api${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
  })
  if (!response.ok) {
    let code = ''
    try { const body = await response.json(); code = typeof body?.error?.code === 'string' ? body.error.code : '' } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
    }
    throw new ApiError(response.status, messages[code])
  }
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
