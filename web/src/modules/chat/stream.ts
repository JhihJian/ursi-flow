import type { ChatMessage, ChatToolPart } from '@/shared/api/types'
import { ApiError, apiErrorFromResponse, getApiTransport } from '@/shared/http/client'

/** 消息流事件：正文分段、工具状态与最终助手消息，错误以 error 行或 HTTP 错误表示。 */
export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; status: ChatToolPart['status']; output?: string }
  | { type: 'done'; message: ChatMessage }

export interface ChatStreamOptions {
  signal?: AbortSignal
  /** 重新生成时沿用最近一条用户消息，服务端不再追加用户消息。 */
  regenerate?: boolean
  onEvent?: (event: ChatStreamEvent) => void
}

function abortError(): DOMException {
  return new DOMException('请求已取消。', 'AbortError')
}

/** 服务端提示与原文都不直接展示，错误码统一走向 shared 的白名单文案。 */
function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  // HTTP 错误响应把码放在 error.code，流内 error 行则直接写在顶层。
  const value = body as { code?: unknown; error?: { code?: unknown } }
  const code = typeof value.error?.code === 'string' ? value.error.code : value.code
  return typeof code === 'string' ? code : undefined
}

/** 非流式错误响应取状态码与错误码，文案由白名单决定。 */
async function failure(response: Response): Promise<ApiError> {
  let code: string | undefined
  try {
    code = errorCode(await response.json())
  } catch {
    code = undefined
  }
  return apiErrorFromResponse(response.status, code)
}

function parseLine(line: string): ChatStreamEvent | undefined {
  const value = line.trim()
  if (!value) return undefined
  let data: unknown
  try {
    data = JSON.parse(value)
  } catch {
    throw new Error('消息流格式不正确，请重试。')
  }
  const event = data as { type?: unknown }
  switch (event.type) {
    case 'delta': {
      const text = (data as { text?: unknown }).text
      if (typeof text !== 'string') throw new Error('消息流格式不正确，请重试。')
      return { type: 'delta', text }
    }
    case 'tool': {
      const tool = data as { name?: unknown; status?: unknown; output?: unknown }
      if (typeof tool.name !== 'string' || !['running', 'succeeded', 'failed'].includes(String(tool.status))) {
        throw new Error('消息流格式不正确，请重试。')
      }
      return { type: 'tool', name: tool.name, status: tool.status as ChatToolPart['status'], ...(typeof tool.output === 'string' ? { output: tool.output } : {}) }
    }
    case 'done': {
      const message = (data as { message?: ChatMessage }).message
      if (!message || typeof message.id !== 'string' || !Array.isArray(message.parts)) throw new Error('消息流格式不正确，请重试。')
      return { type: 'done', message }
    }
    case 'error':
      throw apiErrorFromResponse(503, errorCode(data))
    default:
      throw new Error('消息流格式不正确，请重试。')
  }
}

/**
 * 读取对话消息流：按行解析 NDJSON，把分段与工具事件交给调用方，
 * 结束时返回 done 行里的完整助手消息。中止时抛出 AbortError，由调用方保留已收到的片段。
 */
export async function streamChatMessage(sessionId: string, text: string, options: ChatStreamOptions = {}): Promise<ChatMessage | undefined> {
  const { signal, regenerate = false, onEvent } = options
  const response = await getApiTransport()(`/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(regenerate ? { text, regenerate: true } : { text }),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw await failure(response)
  if (!response.body || !/application\/x-ndjson/i.test(response.headers.get('content-type') ?? '')) {
    throw new ApiError(response.status, '服务返回了非流式数据。')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done: ChatMessage | undefined

  const accept = (line: string) => {
    const event = parseLine(line)
    if (!event) return
    if (event.type === 'done') done = event.message
    onEvent?.(event)
  }

  // 中止时主动取消读取：既中断挂起的 read，也通知服务端停止继续推送分段。
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()

  try {
    for (;;) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) accept(line)
      if (chunk.done) break
    }
    if (buffer) accept(buffer)
  } catch (cause) {
    if (signal?.aborted) throw abortError()
    throw cause
  } finally {
    signal?.removeEventListener('abort', abort)
    try { reader.releaseLock() } catch { /* 流已关闭时无需再释放 */ }
  }

  if (signal?.aborted) throw abortError()
  if (!done) throw new Error('消息流提前结束，请重试。')
  return done
}
