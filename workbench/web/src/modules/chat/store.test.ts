import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setChatTransport } from './demo/client'
import { useChatStore } from './store'
import { createChatTestServer, emptySession, sampleSession } from './testServer'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** 可控的 NDJSON 响应：测试决定何时推送事件与结束，方便构造流式竞态。 */
function controlledStream() {
  const encoder = new TextEncoder()
  let stream!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) { stream = controller },
    cancel() { cancelled = true },
  })
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } }),
    write: (event: unknown) => { if (!cancelled) stream.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)) },
    close: () => { if (!cancelled) stream.close() },
  }
}

async function activate(server: ReturnType<typeof createChatTestServer>, id = 'chat-1') {
  setChatTransport(server.fetch)
  await useChatStore.getState().loadSessions()
  useChatStore.getState().selectSession(id)
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((done) => setTimeout(done, 0))
  }
  throw new Error('等待状态变化超时。')
}

const session = () => useChatStore.getState().sessions.find((item) => item.id === 'chat-1')

beforeEach(() => { useChatStore.setState(useChatStore.getInitialState(), true) })
afterEach(() => { setChatTransport() })

describe('对话状态', () => {
  it('加载会话列表并可切换当前会话', async () => {
    const server = createChatTestServer({ sessions: [sampleSession(), emptySession()] })
    setChatTransport(server.fetch)
    await useChatStore.getState().loadSessions()
    expect(useChatStore.getState().sessions.map((item) => item.id)).toEqual(['chat-1', 'chat-2'])

    useChatStore.getState().selectSession('chat-2')
    expect(useChatStore.getState().currentId).toBe('chat-2')
    expect(useChatStore.getState().error).toBe('')
  })

  it('发送后追加用户消息与助手回复，并把首条消息作为标题', async () => {
    const server = createChatTestServer({ sessions: [emptySession('chat-1', '新对话')] })
    await activate(server)
    await useChatStore.getState().send('现在有哪些运行？')

    const current = session()
    expect(current?.title).toBe('现在有哪些运行？')
    expect(current?.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(current?.messages[0]?.parts).toEqual([{ type: 'text', text: '现在有哪些运行？' }])
    expect(current?.messages[1]?.parts).toEqual([{ type: 'text', text: '**重点**：当前有 3 条运行等待处理。' }])
    expect(useChatStore.getState().streaming).toBe(false)
    expect(useChatStore.getState().error).toBe('')
    expect(server.calls.at(-1)).toMatchObject({ method: 'POST', url: '/chat/sessions/chat-1/messages', body: { text: '现在有哪些运行？' } })
  })

  it('流式过程中可以停止，已生成片段保留且不报错', async () => {
    const gate = deferred()
    const server = createChatTestServer({ hold: () => gate.promise })
    await activate(server)
    const sending = useChatStore.getState().send('先给结论')

    await waitFor(() => useChatStore.getState().streaming)
    await waitFor(() => (session()?.messages.at(-1)?.parts.length ?? 0) > 0)
    expect(session()?.messages.at(-1)?.parts).toEqual([{ type: 'text', text: '第一段，' }])

    useChatStore.getState().stop()
    await sending
    expect(useChatStore.getState().streaming).toBe(false)
    expect(useChatStore.getState().error).toBe('')
    expect(session()?.messages.at(-1)?.parts).toEqual([{ type: 'text', text: '第一段，' }])
  })

  it('重新生成替换末尾的助手消息，不重复追加用户消息', async () => {
    const server = createChatTestServer()
    setChatTransport(server.fetch)
    const sample = sampleSession()
    useChatStore.setState({ sessions: [{ ...sample, messages: [sample.messages[0]!] }], currentId: 'chat-1' })
    await useChatStore.getState().regenerate()

    const current = session()
    expect(current?.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(server.calls.at(-1)).toMatchObject({ method: 'POST', url: '/chat/sessions/chat-1/messages', body: { text: '现在有哪些工作流和运行？', regenerate: true } })
  })

  it('删除会话后从列表移除并清空当前会话', async () => {
    const server = createChatTestServer()
    await activate(server)
    expect(useChatStore.getState().currentId).toBe('chat-1')

    expect(await useChatStore.getState().deleteSession('chat-1')).toBe(true)
    expect(useChatStore.getState().sessions).toEqual([])
    expect(useChatStore.getState().currentId).toBeNull()
    expect(server.calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/chat/sessions/chat-1' })
  })

  it('发送失败时显示错误且不保留空占位消息', async () => {
    setChatTransport((() => Promise.resolve(new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请重试。' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }))) as typeof fetch)
    useChatStore.setState({ sessions: [sampleSession()], currentId: 'chat-1' })

    await useChatStore.getState().send('会失败的问题')
    expect(useChatStore.getState().error).toBe('服务暂时不可用，请重试。')
    expect(useChatStore.getState().streaming).toBe(false)
    expect(session()?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('停止后立即再发送，旧流的收尾不覆盖新流的流式状态', async () => {
    const streams = [controlledStream(), controlledStream()]
    const bodies: unknown[] = []
    let index = 0
    setChatTransport((async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined)
      return streams[index++]!.response
    }) as typeof fetch)
    useChatStore.setState({ sessions: [emptySession('chat-1')], currentId: 'chat-1' })

    const first = useChatStore.getState().send('第一句')
    await waitFor(() => useChatStore.getState().streaming)
    streams[0]!.write({ type: 'delta', text: '第一段' })
    await waitFor(() => (session()?.messages.at(-1)?.parts.length ?? 0) > 0)

    // 停止后同步发起第二次发送：旧流的 finally 稍后才落地。
    useChatStore.getState().stop()
    const second = useChatStore.getState().send('第二句')
    await first

    // 旧流已经结束，但新流仍在进行：streaming 与 streamingId 必须属于新流。
    expect(useChatStore.getState().streaming).toBe(true)
    streams[1]!.write({ type: 'delta', text: '第二段' })
    await waitFor(() => (session()?.messages.at(-1)?.parts.some((part) => part.type === 'text' && part.text === '第二段') ?? false))
    expect(session()?.messages.at(-1)?.parts).toEqual([{ type: 'text', text: '第二段' }])

    streams[1]!.write({
      type: 'done',
      message: { id: 'chat-1-message-9', role: 'assistant', at: '2026-06-10T08:00:00.000Z', parts: [{ type: 'text', text: '第二段' }] },
    })
    streams[1]!.close()
    await second

    expect(useChatStore.getState().streaming).toBe(false)
    expect(useChatStore.getState().error).toBe('')
    expect(session()?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(session()?.messages[1]?.parts).toEqual([{ type: 'text', text: '第一段' }])
    expect(bodies).toEqual([{ text: '第一句' }, { text: '第二句' }])
  })
})
