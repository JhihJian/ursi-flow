import { createMockBackend } from './backend'

let storage: Storage | undefined
try { storage = window.localStorage } catch { /* Use in-memory sessions. */ }
const local = createMockBackend(storage).fetch
let transport = local
export function setChatTransport(next = local) { transport = next }
export function getChatTransport() { return transport }

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
export function apiErrorFromResponse(status: number, code?: string) {
  const message = code === 'SERVICE_UNAVAILABLE' ? '服务暂时不可用，请重试。' : code === 'NOT_FOUND' ? '请求的记录不存在或已被删除。' : '请求失败，请稍后重试。'
  return new ApiError(status, message)
}
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await transport(path, { method, body: JSON.stringify(body) })
  if (!response.ok) throw apiErrorFromResponse(response.status, (await response.json()).error?.code)
  return response.status === 204 ? undefined as T : response.json()
}
export const chatApi = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body: unknown) => call<T>('POST', path, body),
  delete: (path: string) => call('DELETE', path),
}
