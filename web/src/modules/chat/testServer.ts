import type { ChatMessage, ChatPart, ChatSession } from '@/shared/api/types'

const encoder = new TextEncoder()

export interface RecordedCall {
  method: string
  url: string
  body?: Record<string, unknown>
}

export interface ChatTestServerOptions {
  sessions?: ChatSession[]
  /** 助手回复的正文，默认是一段可验证 Markdown 渲染的文本。 */
  reply?: string
  /** 返回的 Promise 完成前消息流不会结束，用于观察流式状态与中止。 */
  hold?: () => Promise<void>
}

export interface ChatTestServer {
  fetch: typeof fetch
  sessions: ChatSession[]
  calls: RecordedCall[]
}

const at = '2026-06-10T08:00:00.000Z'

/** 带正文、推理与工具折叠块的示例会话。 */
export function sampleSession(id = 'chat-1', title = '了解当前演示数据'): ChatSession {
  return {
    id,
    title,
    createdAt: at,
    updatedAt: at,
    messages: [
      { id: `${id}-message-1`, role: 'user', at, parts: [{ type: 'text', text: '现在有哪些工作流和运行？' }] },
      {
        id: `${id}-message-2`,
        role: 'assistant',
        at,
        parts: [
          { type: 'reasoning', text: '先读取演示数据中的工作流与运行记录。' },
          { type: 'tool', name: '读取运行记录', status: 'succeeded', output: '共 3 条运行' },
          { type: 'text', text: '当前有 **3** 个工作流和 3 条运行记录。' },
        ],
      },
    ],
  }
}

export function emptySession(id = 'chat-2', title = '新对话'): ChatSession {
  return { id, title, createdAt: at, updatedAt: at, messages: [] }
}

/**
 * 对话模块测试用的最小 HTTP 替身：只实现会话列表、新建、详情、删除与消息流，
 * 让 store 与视图测试不依赖演示后端，同时逐步推送 NDJSON 分段。
 */
export function createChatTestServer(options: ChatTestServerOptions = {}): ChatTestServer {
  const sessions: ChatSession[] = options.sessions ?? [sampleSession()]
  const calls: RecordedCall[] = []
  const reply = options.reply ?? '**重点**：当前有 3 条运行等待处理。'
  let sequence = 0

  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })

  function replyStream(session: ChatSession, text: string, regenerate: boolean): Response {
    const parts: ChatPart[] = [{ type: 'text', text: reply }]
    if (regenerate) {
      while (session.messages.at(-1)?.role === 'assistant') session.messages.pop()
    } else {
      session.messages.push({ id: `${session.id}-message-${++sequence}`, role: 'user', at, parts: [{ type: 'text', text }] })
    }
    const message: ChatMessage = { id: `${session.id}-message-${++sequence}`, role: 'assistant', at, parts }
    session.messages.push(message)
    const chunks = ['第一段，', '第二段。']
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (line: unknown) => {
          if (!cancelled) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
        }
        write({ type: 'delta', text: chunks[0] })
        if (options.hold) await options.hold()
        write({ type: 'delta', text: chunks[1] })
        write({ type: 'done', message })
        if (!cancelled) controller.close()
      },
      cancel() { cancelled = true },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } })
  }

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input).replace(/^\/api/, '')
    const method = (init?.method ?? 'GET').toUpperCase()
    const raw = typeof init?.body === 'string' ? init.body : ''
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
    calls.push({ method, url, ...(body ? { body } : {}) })

    if (url === '/chat/sessions') {
      if (method === 'GET') return json(sessions)
      if (method === 'POST') {
        const session = emptySession(`chat-${++sequence}`, typeof body?.title === 'string' ? body.title : '新对话')
        sessions.unshift(session)
        return json(session, 201)
      }
    }
    const match = /^\/chat\/sessions\/([^/]+)(\/messages)?$/.exec(url)
    if (match) {
      const id = decodeURIComponent(match[1]!)
      const session = sessions.find((item) => item.id === id)
      if (!session) return json({ error: { code: 'NOT_FOUND', message: '会话不存在或已被删除。' } }, 404)
      if (match[2]) {
        if (method !== 'POST') return json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } }, 404)
        const text = typeof body?.text === 'string' ? body.text : ''
        if (!text.trim()) return json({ error: { code: 'VALIDATION', message: '消息内容不能为空。' } }, 400)
        return replyStream(session, text, body?.regenerate === true)
      }
      if (method === 'GET') return json(session)
      if (method === 'DELETE') {
        sessions.splice(sessions.indexOf(session), 1)
        return new Response(null, { status: 204 })
      }
    }
    return json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } }, 404)
  }

  return { fetch: fetchImpl as typeof fetch, sessions, calls }
}
