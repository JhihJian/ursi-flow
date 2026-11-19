import { describe, expect, it } from 'vitest'

import type { ChatMessage, ChatSession } from '@/shared/api/types'
import { createMockBackend, STORAGE_KEY, type MockStorage } from './backend'

interface StreamLine {
  type: string
  text?: string
  name?: string
  status?: string
  output?: string
  message?: ChatMessage
  code?: string
}

function memoryStorage(): MockStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

/** 演示延迟固定为 0，分段同样立即推进，测试无需等待真实计时器。 */
function harness() {
  const storage = memoryStorage()
  const backend = createMockBackend(storage, { delay: 0 })
  async function call<T>(path: string, method = 'GET', body?: unknown) {
    const response = await backend.fetch(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    })
    const data = (response.status === 204 ? undefined : await response.json()) as T
    return { status: response.status, data, response }
  }
  async function stream(path: string, body: unknown) {
    const response = await backend.fetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
    const raw = await response.text()
    const lines = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as StreamLine)
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', lines }
  }
  return { storage, call, stream }
}

describe('对话演示接口', () => {
  it('提供带推理与工具块的示例会话，并可新建会话', async () => {
    const api = harness()
    const list = await api.call<ChatSession[]>('/chat/sessions')
    expect(list.status).toBe(200)
    expect(list.data).toHaveLength(1)
    expect(list.data[0]?.title).toBe('了解当前演示数据')
    expect(list.data[0]?.messages.map((message) => message.parts.map((part) => part.type))).toEqual([['text'], ['reasoning', 'tool', 'text']])

    const created = await api.call<ChatSession>('/chat/sessions', 'POST', { title: '需求梳理' })
    expect(created.status).toBe(201)
    expect(created.data.title).toBe('需求梳理')
    expect(created.data.messages).toEqual([])
    expect((await api.call<ChatSession[]>('/chat/sessions')).data).toHaveLength(2)
    expect((await api.call<ChatSession>(`/chat/sessions/${created.data.id}`)).data.id).toBe(created.data.id)
  })

  it('消息接口返回 NDJSON 流：工具状态、6–12 段正文与最终消息', async () => {
    const api = harness()
    const result = await api.stream('/chat/sessions/chat-1/messages', { text: '当前有哪些运行？' })
    expect(result.status).toBe(200)
    expect(result.contentType).toContain('application/x-ndjson')

    expect(result.lines.slice(0, 2)).toEqual([
      { type: 'tool', name: '读取运行记录', status: 'running' },
      { type: 'tool', name: '读取运行记录', status: 'succeeded', output: '共 3 条示例运行' },
    ])
    const deltas = result.lines.filter((line) => line.type === 'delta')
    expect(deltas.length).toBeGreaterThanOrEqual(6)
    expect(deltas.length).toBeLessThanOrEqual(12)
    expect(result.lines.at(-1)?.type).toBe('done')

    const message = result.lines.at(-1)?.message
    const text = (message?.parts.find((part) => part.type === 'text') as { text: string }).text
    expect(deltas.map((line) => line.text).join('')).toBe(text)
    expect(text).toContain('本地演示回复，未调用模型')
    expect(text).toContain('工作流 3 个')
    expect(text).toContain('运行记录 3 条')
    expect(message?.parts.map((part) => part.type)).toEqual(['reasoning', 'tool', 'text'])
    expect(message?.role).toBe('assistant')
  })

  it('消息写入会话并持久化，标题取首条用户消息前 24 字', async () => {
    const api = harness()
    const created = await api.call<ChatSession>('/chat/sessions', 'POST', {})
    expect(created.data.title).toBe('新对话')

    const text = '把当前的工作流、运行记录和审批状态整理成一份简短的进展汇报'
    await api.stream(`/chat/sessions/${created.data.id}/messages`, { text })
    const saved = (await api.call<ChatSession>(`/chat/sessions/${created.data.id}`)).data
    expect(saved.title).toBe(Array.from(text).slice(0, 24).join(''))
    expect(saved.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(saved.messages[0]?.parts).toEqual([{ type: 'text', text }])

    const persisted = JSON.parse(api.storage.getItem(STORAGE_KEY) ?? '{}') as { chatSessions: ChatSession[] }
    const stored = persisted.chatSessions.find((session) => session.id === created.data.id)
    expect(stored?.messages).toHaveLength(2)
    expect(stored?.messages[1]?.parts.some((part) => part.type === 'text')).toBe(true)
  })

  it('重新生成沿用最近一条用户消息，不重复追加用户消息', async () => {
    const api = harness()
    await api.stream('/chat/sessions/chat-1/messages', { text: '继续说明' })
    const before = (await api.call<ChatSession>('/chat/sessions/chat-1')).data
    expect(before.messages.filter((message) => message.role === 'user')).toHaveLength(2)

    await api.stream('/chat/sessions/chat-1/messages', { regenerate: true })
    const after = (await api.call<ChatSession>('/chat/sessions/chat-1')).data
    expect(after.messages.filter((message) => message.role === 'user')).toHaveLength(2)
    expect(after.messages.at(-1)?.role).toBe('assistant')
  })

  it('删除会话后不可再读取，空消息与未知路径返回结构化错误', async () => {
    const api = harness()
    expect((await api.call('/chat/sessions/chat-1', 'DELETE')).status).toBe(204)
    const missing = await api.call<{ error: { code: string } }>('/chat/sessions/chat-1')
    expect(missing.status).toBe(404)
    expect(missing.data.error.code).toBe('NOT_FOUND')

    const empty = await api.call<{ error: { code: string } }>('/chat/sessions/chat-1/messages', 'POST', { text: '  ' })
    expect(empty.status).toBe(404)

    await api.call('/chat/sessions', 'POST', { title: '临时会话' })
    const sessions = (await api.call<ChatSession[]>('/chat/sessions')).data
    const target = sessions.find((session) => session.title === '临时会话')!
    const invalid = await api.call<{ error: { code: string } }>(`/chat/sessions/${target.id}/messages`, 'POST', { text: '  ' })
    expect(invalid.status).toBe(400)
    expect(invalid.data.error.code).toBe('VALIDATION')
    expect((await api.call('/chat/sessions/unknown/messages', 'POST', { text: '你好' })).status).toBe(404)
  })

  it('本地对话传输不处理 Flow 请求', async () => {
    expect((await harness().call('/flows')).status).toBe(404)
  })
})
