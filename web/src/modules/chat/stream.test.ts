import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setApiTransport } from '@/shared/http/client'
import { streamChatMessage, type ChatStreamEvent } from './stream'

const sessionId = 'chat-1'
const encoder = new TextEncoder()

interface Call { url: string; init: RequestInit }

function useTransport(handler: (url: string, init: RequestInit) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  setApiTransport(((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const request = init ?? {}
    calls.push({ url, init: request })
    return Promise.resolve(handler(url, request))
  }) as typeof fetch)
  return calls
}

function ndjson(chunks: string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } })
}

const reply = {
  id: 'chat-1-message-2', role: 'assistant' as const, at: '2026-06-10T08:00:00.000Z',
  parts: [{ type: 'text' as const, text: '你好，世界' }],
}

beforeEach(() => { setApiTransport((...args) => globalThis.fetch(...args)) })
afterEach(() => { setApiTransport((...args) => globalThis.fetch(...args)) })

describe('读取对话消息流', () => {
  it('逐行解析被拆开的 NDJSON 分段并返回最终助手消息', async () => {
    const calls = useTransport(() => ndjson([
      '{"type":"delta","text":"你好',
      '"}\n{"type":"delta","text":"，世界"}\n',
      `{"type":"done","message":${JSON.stringify(reply)}}\n`,
    ]))
    const events: ChatStreamEvent[] = []
    const message = await streamChatMessage(sessionId, '现在有哪些运行？', { onEvent: (event) => { events.push(event) } })

    expect(events.filter((event) => event.type === 'delta').map((event) => (event as { text: string }).text)).toEqual(['你好', '，世界'])
    expect(message).toEqual(reply)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`/api/chat/sessions/${sessionId}/messages`)
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: '现在有哪些运行？' })
  })

  it('把工具状态行交给调用方，末尾没有换行也能解析', async () => {
    const events: ChatStreamEvent[] = []
    useTransport(() => ndjson([
      '{"type":"tool","name":"读取运行记录","status":"running"}\n{"type":"tool","name":"读取运行记录","status":"succeeded","output":"3 条运行"}',
    ]))
    await expect(streamChatMessage(sessionId, '问题', { onEvent: (event) => { events.push(event) } })).rejects.toThrow('消息流提前结束')
    expect(events).toEqual([
      { type: 'tool', name: '读取运行记录', status: 'running' },
      { type: 'tool', name: '读取运行记录', status: 'succeeded', output: '3 条运行' },
    ])
  })

  it('重新生成时携带 regenerate 标记', async () => {
    const calls = useTransport(() => ndjson([`{"type":"done","message":${JSON.stringify(reply)}}\n`]))
    await streamChatMessage(sessionId, '同一个问题', { regenerate: true })
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: '同一个问题', regenerate: true })
  })

  it('流内 error 行按错误码白名单给出文案，不直接展示服务端原文', async () => {
    useTransport(() => ndjson(['{"type":"error","code":"SERVICE_UNAVAILABLE","message":"模拟服务暂时不可用，请重试。"}\n']))
    const error = await streamChatMessage(sessionId, '问题').catch((cause: unknown) => cause)
    expect(error).toMatchObject({ status: 503, message: '服务暂时不可用，请重试。' })
    expect(String(error)).not.toContain('模拟服务暂时不可用')

    useTransport(() => ndjson(['{"type":"error","code":"NOT_FOUND","message":"原始服务端文案"}\n']))
    await expect(streamChatMessage(sessionId, '问题')).rejects.toMatchObject({ status: 503, message: '请求的记录不存在或已被删除。' })
  })

  it('流内未知或缺失错误码使用通用文案', async () => {
    useTransport(() => ndjson(['{"type":"error","code":"NEW_CODE","message":"原始服务端文案"}\n']))
    const unknown = await streamChatMessage(sessionId, '问题').catch((cause: unknown) => cause)
    expect(unknown).toMatchObject({ status: 503, message: '请求失败，请稍后重试。' })
    expect(String(unknown)).not.toContain('原始服务端文案')

    useTransport(() => ndjson(['{"type":"error","message":"原始服务端文案"}\n']))
    await expect(streamChatMessage(sessionId, '问题')).rejects.toThrow('请求失败，请稍后重试。')
  })

  it('非流式错误响应按错误码白名单转成可读错误', async () => {
    useTransport(() => new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '原始服务端文案' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }))
    const error = await streamChatMessage(sessionId, '问题').catch((cause: unknown) => cause)
    expect(error).toMatchObject({ status: 503, message: '服务暂时不可用，请重试。' })
    expect(String(error)).not.toContain('原始服务端文案')

    useTransport(() => new Response(JSON.stringify({ error: { code: 'SOMETHING_NEW', message: '原始服务端文案' } }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    }))
    await expect(streamChatMessage(sessionId, '问题')).rejects.toMatchObject({ status: 502, message: '请求失败，请稍后重试。' })

    useTransport(() => new Response('secret-canary', { status: 502, headers: { 'Content-Type': 'text/plain' } }))
    const unreadable = await streamChatMessage(sessionId, '问题').catch((cause: unknown) => cause)
    expect(unreadable).toMatchObject({ status: 502, message: '请求失败，请稍后重试。' })
    expect(String(unreadable)).not.toContain('secret-canary')
  })

  it('内容类型不是 NDJSON 时拒绝解析', async () => {
    useTransport(() => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await expect(streamChatMessage(sessionId, '问题')).rejects.toThrow('服务返回了非流式数据。')
  })

  it('中止时取消读取并保留已收到的分段', async () => {
    const controller = new AbortController()
    let cancelled = false
    useTransport(() => new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(encoder.encode('{"type":"delta","text":"部分"}\n')) },
      cancel() { cancelled = true },
    }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }))

    const events: ChatStreamEvent[] = []
    const settled = streamChatMessage(sessionId, '问题', { signal: controller.signal, onEvent: (event) => { events.push(event) } })
      .catch((error: unknown) => error)
    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    controller.abort()

    expect(await settled).toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
  })
})
