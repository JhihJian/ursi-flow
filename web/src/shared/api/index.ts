import { requestJson } from '@/shared/http/client'

async function json<T>(path: string, options?: RequestInit): Promise<T> {
  const result = await requestJson<T>(path, options)
  if (result === undefined) throw new Error('服务没有返回数据。')
  return result
}
export const api = {
  get: <T>(path: string, signal?: AbortSignal) => json<T>(path, { signal }),
  post: <T>(path: string, body: unknown = {}) => json<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => json<T>(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  delete: async (path: string) => { await requestJson(path, { method: 'DELETE' }) },
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。'
}
