import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  validateUIMessages,
} from 'ai'

import { DEFAULT_MODEL, isModelAllowed } from './models.ts'
import { getTools, type ChatUIMessage } from './tools/index.ts'

const PORT = Number(process.env.PORT ?? 8198)
const HOST = process.env.HOST ?? '0.0.0.0'
const MAX_OUTPUT_TOKENS = 8192

const serverDir = path.dirname(fileURLToPath(import.meta.url))
// 默认托管 web 构建产物，可用 CHAT_WEB_STATIC_DIR 覆盖。
const STATIC_DIR = process.env.CHAT_WEB_STATIC_DIR ?? path.resolve(serverDir, '../../web/dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return undefined
  return JSON.parse(raw)
}

// 该端点公开且按请求消耗 AI Gateway 额度，仅做单请求约束，不限制总量。
// 暴露给真实流量前应加限流、鉴权与额度上限，见 README「安全」。
async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body.' })
    return
  }

  const model = (body as { model?: unknown })?.model
  const modelId = typeof model === 'string' ? model : DEFAULT_MODEL

  if (!isModelAllowed(modelId)) {
    sendJson(res, 400, { error: `Model ${modelId} is not available.` })
    return
  }

  const tools = getTools(modelId)

  // 信任消息与工具 part 前先校验形状。
  let messages: ChatUIMessage[]
  try {
    const validated = await validateUIMessages<ChatUIMessage>({
      messages: (body as { messages?: unknown })?.messages,
      tools: tools as Parameters<typeof validateUIMessages>[0]['tools'],
    })
    messages = validated
  } catch {
    sendJson(res, 400, { error: 'Invalid messages.' })
    return
  }

  // 客户端断开即中止生成，避免继续消耗额度。
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  const result = streamText({
    model: modelId,
    messages: await convertToModelMessages(messages),
    tools,
    stopWhen: isStepCount(5),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: controller.signal,
  })

  // ask_user 之后的回复延续上一条消息，因此只累计它的 reasoning part 数。
  const lastMessage = messages.at(-1)
  let reasoningCount =
    lastMessage?.role === 'assistant'
      ? lastMessage.parts.filter((part) => part.type === 'reasoning').length
      : 0
  const reasoningStarts = new Map<string, { index: number; time: number }>()

  const response = createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      sendSources: true,
      // AI SDK 不统计 reasoning 耗时，这里逐块计时。
      messageMetadata: ({ part }) => {
        if (part.type === 'reasoning-start') {
          reasoningStarts.set(part.id, {
            index: reasoningCount++,
            time: Date.now(),
          })
        }

        const start =
          part.type === 'reasoning-end'
            ? reasoningStarts.get(part.id)
            : undefined

        if (!start) {
          return undefined
        }

        return {
          reasoningDurations: { [start.index]: Date.now() - start.time },
        }
      },
      onError: () => 'Something went wrong. Please try again.',
    }),
  })

  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (response.body) {
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res)
  } else {
    res.end()
  }
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const decoded = decodeURIComponent(pathname)
  // 逐段校验，拒绝越界与非法路径。
  const segments = decoded.split('/').filter(Boolean)
  if (segments.some((segment) => segment === '..' || segment.includes('\0'))) {
    sendJson(res, 400, { error: 'Invalid path.' })
    return
  }

  let filePath = path.join(STATIC_DIR, ...segments)
  if (!filePath.startsWith(STATIC_DIR)) {
    sendJson(res, 400, { error: 'Invalid path.' })
    return
  }

  try {
    const stat = await fs.stat(filePath)
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html')
    }
    const content = await fs.readFile(filePath)
    const ext = path.extname(filePath)
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' })
    res.end(content)
  } catch {
    // SPA fallback：无匹配文件时回退到 index.html。
    try {
      const index = await fs.readFile(path.join(STATIC_DIR, 'index.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(index)
    } catch {
      sendJson(res, 404, { error: 'Not found.' })
    }
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    void handleChat(req, res)
    return
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true })
    return
  }
  if (req.method === 'GET') {
    void serveStatic(res, url.pathname)
    return
  }
  sendJson(res, 404, { error: 'Not found.' })
})

server.listen(PORT, HOST, () => {
  console.log(`chat-web server listening on http://${HOST}:${PORT}`)
})
