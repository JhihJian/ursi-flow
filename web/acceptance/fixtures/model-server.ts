/**
 * 模拟模型端点。只模拟模型，不模拟执行器、工作数据或验收接口。
 * 形式与 server/tests/work_e2e.py 的 simulated_model 一致：
 * 只接受已配置的流式模型，固定返回 `SIMULATED-MODEL: fixed report`，
 * 并把每次请求的模型名与消息写进 JSONL，供验收断言和报告取证。
 *
 * 由 global-setup 以独立子进程启动：node acceptance/fixtures/model-server.ts
 */
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const MODEL = 'fixed-local-model'
const ANSWER = 'SIMULATED-MODEL: fixed report'
const PORT = Number(process.env.MODEL_PORT ?? '18102')
const LOG = process.env.MODEL_LOG ?? ''

type Message = { role?: string; content?: unknown }
type Body = { model?: string; stream?: boolean; messages?: Message[] }

const text = (content: unknown) => typeof content === 'string' ? content : JSON.stringify(content)

function record(body: Body) {
  const entry = {
    at: new Date().toISOString(),
    model: body.model ?? null,
    stream: body.stream ?? null,
    messages: (body.messages ?? []).map(message => ({ role: message.role ?? '', content: text(message.content) })),
  }
  if (LOG) appendFileSync(LOG, JSON.stringify(entry) + '\n')
}

function chunks(): string {
  const frames = [
    { delta: { role: 'assistant', content: ANSWER }, finish: null },
    { delta: {}, finish: 'stop' },
  ]
  return frames.map(frame => 'data: ' + JSON.stringify({
    id: 'local', object: 'chat.completion.chunk', model: MODEL, created: 1,
    choices: [{ index: 0, delta: frame.delta, finish_reason: frame.finish }],
  }) + '\n\n').join('') + 'data: [DONE]\n\n'
}

function handle(request: IncomingMessage, response: ServerResponse) {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
    return
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
    return
  }
  let raw = ''
  request.on('data', chunk => { raw += String(chunk) })
  request.on('end', () => {
    let body: Body = {}
    try { body = JSON.parse(raw) as Body } catch { body = {} }
    record(body)
    if (body.model !== MODEL || body.stream !== true) {
      response.writeHead(400, { 'Content-Type': 'text/plain' }).end('expected configured streaming model')
      return
    }
    const data = Buffer.from(chunks(), 'utf8')
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Length': String(data.length) })
    response.end(data)
  })
}

createServer(handle).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`model endpoint listening on 127.0.0.1:${PORT}\n`)
})
