import { chatRoute } from './chat'
import { createSeed, type MockState } from './seed'

export const STORAGE_KEY = 'ursi-flow:chat-demo'
export type MockStorage = Pick<Storage, 'getItem' | 'setItem'>
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
export function createMockBackend(storage?: MockStorage, options: { delay?: number } = {}) {
  let state = createSeed(options.delay ?? 90)
  try {
    // Preserve chat sessions from the previous all-in-one demo without importing its business resources.
    const raw = storage?.getItem(STORAGE_KEY) ?? storage?.getItem('ursi-flow-demo-v1')
    const saved: MockState | null = raw ? JSON.parse(raw) : null
    if (saved && Array.isArray(saved.chatSessions) && Number.isSafeInteger(saved.sequence)) {
      state = { ...state, chatSessions: saved.chatSessions, sequence: saved.sequence }
    }
  } catch { /* Storage can be disabled in a private browsing context. */ }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    init?.signal?.throwIfAborted()
    const method = init?.method ?? 'GET'
    try {
      const draft = structuredClone(state)
      const result = chatRoute(draft, method, new URL(String(input), 'https://chat.invalid'), JSON.parse(String(init?.body ?? '{}')), Date.now())
      if (method !== 'GET') {
        storage?.setItem(STORAGE_KEY, JSON.stringify(draft))
        state = draft
      }
      return result.response ?? (result.status === 204 ? new Response(null, { status: 204 }) : Response.json(result.value, { status: result.status ?? 200 }))
    } catch (cause) {
      const error = cause instanceof HttpError ? cause : new HttpError(503, 'SERVICE_UNAVAILABLE', '会话无法保存')
      return Response.json({ error: { code: error.code } }, { status: error.status })
    }
  }
  return { fetch }
}
