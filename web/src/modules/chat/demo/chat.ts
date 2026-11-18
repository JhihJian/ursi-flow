import type { ChatMessage, ChatPart, ChatSession, ChatToolPart } from '@/shared/api/types'
import { HttpError } from './backend'
import type { MockState } from './seed'

/** 消息正文固定拆成 6–12 段，段间使用真实计时器推进，取消读取即中断。 */
const MIN_SEGMENTS = 6
const MAX_SEGMENTS = 12
const MIN_GAP = 60
const MAX_GAP = 120
/** 标题取首条用户消息的前 24 字。 */
const TITLE_LENGTH = 24
const DEFAULT_TITLE = '新对话'

const CHAT_PATH = /^\/chat\/sessions(?:\/([^/]+))?(?:\/([^/]+))?\/?$/

export interface ChatRouteResult {
  value?: unknown
  status?: number
  /** 消息接口返回自建的 NDJSON 流，其余接口仍由 backend 包装成 JSON。 */
  response?: Response
}

const iso = (now: number) => new Date(now).toISOString()
const uid = (state: MockState, prefix: string) => `${prefix}-${++state.sequence}`
const trim = (value: string, length: number) => Array.from(value).slice(0, length).join('')

function sessionOf(state: MockState, id: string): ChatSession {
  const session = state.chatSessions.find((entry) => entry.id === id)
  if (!session) throw new HttpError(404, 'NOT_FOUND', '会话不存在或已被删除。')
  return session
}

function promptOf(body: Record<string, unknown>): string {
  const value = typeof body.text === 'string' ? body.text.trim() : ''
  if (!value) throw new HttpError(400, 'VALIDATION', '消息内容不能为空。')
  return value
}

/** 本地模板回复：只引用当前演示数据，不调用任何模型。 */
function composeParts(prompt: string): ChatPart[] {
  const brief = trim(prompt, 30)
  const text = [
    `关于「${brief}」，我先读取了当前演示工作区：`,
    '',
    '- 示例工作流 3 个：产品需求交付、代码审查、文档整理',
    '- 示例运行记录 3 条：等待审批、已完成、执行中各一条。',
    '',
    '> 这是本地演示回复，未调用模型。内容由演示模板按当前演示数据生成。',
  ].join('\n')
  return [
    { type: 'reasoning', text: '先读取演示工作区的工作流与运行记录，再按问题汇总当前状态。' },
    { type: 'tool', name: '读取运行记录', status: 'succeeded', output: '共 3 条示例运行' },
    { type: 'text', text },
  ]
}

function segmentCount(content: string): number {
  return Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, Math.ceil(content.length / 18)))
}

/** 按固定段数切分正文，段内不破坏顺序，空正文至少返回一段。 */
function segments(content: string): string[] {
  if (!content) return ['']
  const count = segmentCount(content)
  const size = Math.ceil(content.length / count)
  const chunks: string[] = []
  for (let start = 0; start < content.length; start += size) chunks.push(content.slice(start, start + size))
  return chunks
}

/** 段间隔在 60–120ms 内按段序稳定波动；演示延迟为 0 时同步归零，便于自动化测试不等待真实计时器。 */
function gapAfter(index: number, instant: boolean): number {
  if (instant) return 0
  return MIN_GAP + ((index * 37) % (MAX_GAP - MIN_GAP + 1))
}

function textOf(message: ChatMessage): string {
  return message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

function toolsOf(message: ChatMessage): ChatToolPart[] {
  return message.parts.filter((part): part is ChatToolPart => part.type === 'tool')
}

type ChatStreamLine =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; status: ChatToolPart['status']; output?: string }
  | { type: 'done'; message: ChatMessage }

/**
 * 组一条 NDJSON 流：先报工具调用，再分段输出正文，最后以 done 结束。
 * 读取被取消时停止计时器，不再写入剩余分段。
 */
function streamResponse(state: MockState, message: ChatMessage): Response {
  const encoder = new TextEncoder()
  const script: ChatStreamLine[] = []
  for (const tool of toolsOf(message)) {
    script.push({ type: 'tool', name: tool.name, status: 'running' })
    script.push({ type: 'tool', name: tool.name, status: 'succeeded', ...(tool.output ? { output: tool.output } : {}) })
  }
  for (const chunk of segments(textOf(message))) script.push({ type: 'delta', text: chunk })
  const instant = state.settings.delay === 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (line: ChatStreamLine) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
      let cursor = 0
      const tick = () => {
        if (cancelled) return
        const line = script[cursor]
        if (!line) {
          write({ type: 'done', message })
          controller.close()
          return
        }
        write(line)
        cursor += 1
        timer = setTimeout(tick, gapAfter(cursor, instant))
      }
      timer = setTimeout(tick, gapAfter(0, instant))
    },
    cancel() {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/**
 * 对话演示接口：会话列表、新建、详情、删除，以及返回 NDJSON 流的消息接口。
 * 消息接口同步把用户消息与助手消息写入传入的状态树，由 backend 负责整树提交，
 * 因此中止读取只会中断界面展示，会话数据仍保持完整。
 */
export function chatRoute(state: MockState, method: string, url: URL, body: Record<string, unknown>, now: number): ChatRouteResult {
  const match = CHAT_PATH.exec(url.pathname)
  if (!match) throw new HttpError(404, 'NOT_FOUND', '接口不存在。')
  const id = match[1] ? decodeURIComponent(match[1]) : ''
  const action = match[2]

  if (!id) {
    if (method === 'GET') {
      return { value: [...state.chatSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
    }
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? trim(body.title.trim(), TITLE_LENGTH) : ''
      const session: ChatSession = { id: uid(state, 'chat'), title: title || DEFAULT_TITLE, createdAt: iso(now), updatedAt: iso(now), messages: [] }
      state.chatSessions.unshift(session)
      return { value: session, status: 201 }
    }
    throw new HttpError(404, 'NOT_FOUND', '接口不存在。')
  }

  const session = sessionOf(state, id)
  if (!action) {
    if (method === 'GET') return { value: session }
    if (method === 'DELETE') {
      state.chatSessions = state.chatSessions.filter((entry) => entry.id !== id)
      return { status: 204 }
    }
    throw new HttpError(404, 'NOT_FOUND', '接口不存在。')
  }
  if (action !== 'messages' || method !== 'POST') throw new HttpError(404, 'NOT_FOUND', '接口不存在。')

  // 重新生成沿用最近一条用户消息，先退掉末尾的助手消息，不再追加用户输入。
  const regenerate = body.regenerate === true
  let prompt: string
  if (regenerate) {
    const lastUser = [...session.messages].reverse().find((message) => message.role === 'user')
    prompt = lastUser ? textOf(lastUser) : promptOf(body)
    while (session.messages.at(-1)?.role === 'assistant') session.messages.pop()
  } else {
    prompt = promptOf(body)
    if (!session.messages.some((message) => message.role === 'user')) session.title = trim(prompt, TITLE_LENGTH)
    session.messages.push({ id: uid(state, 'chat-message'), role: 'user', at: iso(now), parts: [{ type: 'text', text: prompt }] })
  }
  const reply: ChatMessage = { id: uid(state, 'chat-message'), role: 'assistant', at: iso(now), parts: composeParts(prompt) }
  session.messages.push(reply)
  session.updatedAt = iso(now)
  return { response: streamResponse(state, reply) }
}
