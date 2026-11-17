import { setApiTransport } from '@/shared/http/client'
import { createMockBackend, type MockStorage } from './backend'

export { createMockBackend, STORAGE_KEY } from './backend'
export type { MockOptions, MockStorage } from './backend'

/** 只替换应用的 HTTP transport，浏览器其他 fetch 请求保持原行为。 */
export function startMockApi(): void {
  let storage: MockStorage | undefined
  try { storage = window.localStorage } catch { /* 浏览器禁用存储时保持本次会话可用。 */ }
  setApiTransport(createMockBackend(storage).fetch)
}
