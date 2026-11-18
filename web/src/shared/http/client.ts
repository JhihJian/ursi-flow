let apiTransport: typeof fetch = (...args) => globalThis.fetch(...args)

/** 由应用入口选择演示或网络传输，业务模块始终调用同一个 API 契约。 */
export function setApiTransport(transport: typeof fetch) { apiTransport = transport }

/** 返回当前注入的 transport，供需要直接读取响应流的调用方复用同一实现。 */
export function getApiTransport(): typeof fetch { return apiTransport }

const FALLBACK_MESSAGE = '请求失败，请稍后重试。'

const messages = new Map<string, string>([
  ['VALIDATION', '配置校验失败，请检查必填字段、地址和凭据引用。'],
  ['REFERENCE_CONFLICT', '此资源仍被其他配置引用，请先解除引用后再删除。'],
  ['INVALID_STATE', '当前状态不允许此操作，请刷新后重试。'],
  ['NOT_FOUND', '请求的记录不存在或已被删除。'],
  ['SERVICE_UNAVAILABLE', '服务暂时不可用，请重试。'],
  ['INVALID_WORKFLOW', '流程定义不合法，请检查节点、连线和角色引用。'],
])

/** HTTP 错误只保留状态码和白名单提示，原始响应可能包含敏感信息。 */
export class ApiError extends Error {
  constructor(public readonly status: number, message = FALLBACK_MESSAGE) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 错误码只映射白名单文案，未知错误码退回通用提示，服务端原文不外泄。 */
export function apiErrorMessage(code?: string): string {
  return (code ? messages.get(code) : undefined) ?? FALLBACK_MESSAGE
}

/** 由状态码与错误码构造可复用错误，供普通请求与自定义响应流共用同一套文案。 */
export function apiErrorFromResponse(status: number, code?: string): ApiError {
  return new ApiError(status, apiErrorMessage(code))
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
    throw apiErrorFromResponse(response.status, code)
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
