// 独立 Flow 控制台：托管静态包，并把同源 /api/v1 请求转成 ursi-flowd 的 Unix socket 协议。
// HTTP 路径与请求体与 workbench 的 /api/v1 保持一致，静态包可直接嵌入工作台。
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { pathToFileURL } from 'node:url'

const dist = new URL('./dist/', import.meta.url)
const REQUEST_LIMIT = 2 * 1024 * 1024
const RESPONSE_LIMIT = 16 * 1024 * 1024
const TIMEOUT_MS = 35000
const MAX_CONCURRENT = 8

class BridgeError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}
// daemon 的业务错误码与 workbench 的 HTTP 映射保持一致。
const daemonErrors = {
  invalid_input: [400, 'invalid_request', true],
  not_found: [404, 'not_found', true],
  conflict: [409, 'conflict', true],
  busy: [429, 'runtime_busy', true],
}
const transportErrors = {
  ENOENT: [503, 'runtime_unavailable', 'Runtime 未启动'],
  ECONNREFUSED: [503, 'runtime_unavailable', 'Runtime 未启动'],
  ECONNRESET: [502, 'runtime_protocol_error', 'Runtime 连接中断'],
}

function callDaemon(socketPath, op, args) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    const chunks = []
    let size = 0
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn(value)
    }
    const timer = setTimeout(
      () => finish(reject, new BridgeError('runtime_timeout', 'Runtime 响应超时', 504)),
      TIMEOUT_MS,
    )
    socket.on('connect', () =>
      // 写完立即半关闭，daemon 在 end 事件里才处理请求。
      socket.end(JSON.stringify({ v: 1, op, args }) + '\n'),
    )
    socket.on('data', (chunk) => {
      size += chunk.length
      if (size > RESPONSE_LIMIT)
        return finish(
          reject,
          new BridgeError('runtime_protocol_error', 'Runtime 响应过大', 502),
        )
      chunks.push(chunk)
    })
    socket.on('error', (e) => {
      const mapped = transportErrors[e.code]
      finish(
        reject,
        mapped
          ? new BridgeError(mapped[1], mapped[2], mapped[0])
          : new BridgeError('runtime_unavailable', 'Runtime 连接失败', 503),
      )
    })
    socket.on('end', () => {
      let reply
      try {
        reply = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return finish(
          reject,
          new BridgeError('runtime_protocol_error', 'Runtime 返回了无效响应', 502),
        )
      }
      if (!reply || reply.v !== 1 || ('data' in reply) === ('error' in reply))
        return finish(
          reject,
          new BridgeError('runtime_protocol_error', 'Runtime 返回了无效响应', 502),
        )
      if ('data' in reply) return finish(resolve, reply.data)
      const mapped = daemonErrors[reply.code]
      if (typeof reply.error !== 'string' || (reply.code != null && !mapped))
        return finish(
          reject,
          new BridgeError('runtime_protocol_error', 'Runtime 返回了无效响应', 502),
        )
      finish(
        reject,
        mapped
          ? new BridgeError(mapped[1], String(reply.error).slice(0, 512), mapped[0])
          : new BridgeError('internal_error', 'Runtime 处理失败', 500),
      )
    })
  })
}

const idPattern = /^[A-Za-z0-9][\w-]{0,95}$/
function invalid(message) {
  throw new BridgeError('invalid_request', message, 400)
}
function requireId(value) {
  if (typeof value !== 'string' || !idPattern.test(value)) invalid('非法标识')
  return value
}
function requireFiles(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('需要文件集合')
  return value
}

// 把一次同源 HTTP 请求翻译成 daemon 操作；不认识的路径返回 null。
function route(method, path, body, context) {
  if (path === '/api/v1/flows') {
    // 不带查询参数时只返回标识，列表页用 detail=1 一次取回名称、说明与规模。
    if (method === 'GET')
      return context.query?.get('detail') === '1'
        ? { op: 'flow.summaries', args: {} }
        : { op: 'flow.list', args: {} }
    if (method === 'POST')
      return {
        op: 'flow.create',
        args: { id: requireId(body.id), files: requireFiles(body.files) },
      }
  }
  if (path === '/api/v1/flows/validate' && method === 'POST')
    return {
      op: 'flow.validate',
      args: { id: requireId(body.id), files: requireFiles(body.files) },
    }
  let match
  if ((match = path.match(/^\/api\/v1\/flows\/([^/]+)(\/runs)?$/))) {
    const id = requireId(safeDecode(match[1]))
    if (match[2]) {
      if (method !== 'POST') return null
      if (body.workspace !== undefined && body.workspace !== 'default')
        invalid('只接受 default 工作区')
      const variables = body.variables === undefined ? {} : body.variables
      if (!variables || typeof variables !== 'object' || Array.isArray(variables))
        invalid('变量必须是对象')
      const runId =
        body.runId === undefined || body.runId === null
          ? randomUUID()
          : requireId(body.runId)
      // cwd 由调用方决定：留空时 daemon 在配置的工作区根目录下按 Run ID 新建。
      const cwd = body.cwd === undefined || body.cwd === null ? '' : body.cwd
      if (typeof cwd !== 'string' || cwd.includes('\0')) invalid('工作目录无效')
      return {
        op: 'run.start',
        args: { id: runId, flow: id, variables, ...(cwd.trim() ? { cwd } : {}) },
      }
    }
    if (method === 'GET') return { op: 'flow.get', args: { id } }
    if (method === 'PUT') {
      const args = { id, files: requireFiles(body.files) }
      if (body.expectedRevision !== undefined) {
        if (typeof body.expectedRevision !== 'string')
          invalid('expectedRevision 必须是字符串')
        args.expectedRevision = body.expectedRevision
      }
      return { op: 'flow.update', args }
    }
    if (method === 'DELETE') return { op: 'flow.delete', args: { id } }
  }
  if ((match = path.match(/^\/api\/v1\/runs\/([^/]+)\/flow$/)) && method === 'GET')
    return { op: 'run.flow', args: { id: requireId(safeDecode(match[1])) } }
  if (
    (match = path.match(/^\/api\/v1\/runs\/([^/]+)\/nodes\/([^/]+)\/trajectory$/)) &&
    method === 'GET'
  )
    return {
      op: 'run.trajectory',
      args: {
        id: requireId(safeDecode(match[1])),
        node: requireId(safeDecode(match[2])),
      },
    }
  if ((match = path.match(/^\/api\/v1\/runs\/([^/]+)(\/history|\/stop)?$/))) {
    const id = requireId(safeDecode(match[1]))
    if (!match[2] && method === 'GET') return { op: 'run.get', args: { id } }
    if (match[2] === '/history' && method === 'GET')
      return { op: 'run.history', args: { id } }
    if (match[2] === '/stop' && method === 'POST')
      return { op: 'run.stop', args: { id } }
  }
  if (path === '/api/v1/runs' && method === 'GET')
    return { op: 'run.list', args: {} }
  if (path === '/api/v1/flow-config') {
    if (method === 'GET') return { op: 'config.get', args: {} }
    if (method === 'PATCH') {
      if (!body || typeof body !== 'object' || Array.isArray(body))
        invalid('配置必须是对象')
      return { op: 'config.update', args: body }
    }
  }
  return null
}
function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return invalid('非法路径')
  }
}

export async function createConsole(env) {
  // 页面不做访问令牌验证。工作目录缺失时进入演示模式。
  const live = Boolean(env.URSI_FLOW_WORKDIR)
  let cwd
  if (live) {
    try {
      cwd = await realpath(env.URSI_FLOW_WORKDIR)
      if (!(await stat(cwd)).isDirectory()) throw Error()
    } catch {
      throw Error('URSI_FLOW_WORKDIR 必须是已存在的目录')
    }
  }
  const socketPath = join(
    env.URSI_FLOW_HOME || join(homedir(), '.ursi-flow'),
    'runtime.sock',
  )
  const extraHosts = (env.URSI_FLOW_WEB_HOSTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  let active = 0
  const config = live
    ? { mode: 'live', apiBase: '/api/v1', workspace: { name: 'default', path: cwd } }
    : { mode: 'demo' }
  const serve =
    env.URSI_FLOW_WEB_TLS_CERT || env.URSI_FLOW_WEB_TLS_KEY
      ? https.createServer.bind(https, {
          cert: readFileSync(env.URSI_FLOW_WEB_TLS_CERT),
          key: readFileSync(env.URSI_FLOW_WEB_TLS_KEY),
        })
      : http.createServer
  return serve(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        // 画布与图表用行内样式定位节点，轨迹里的图片块是 data: URI，脚本仍然只允许同源资源。
        'Content-Security-Policy':
          "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      })
      res.end(body)
    }
    const fail = (error) => {
      const known = error instanceof BridgeError
      return send(
        known ? error.status : 500,
        JSON.stringify({
          error: {
            code: known ? error.code : 'internal_error',
            message: known ? error.message : '控制台内部错误',
          },
        }),
      )
    }
    // 只接受 IP 字面量、localhost 或显式登记的域名，避免域名重绑定读取本机数据。
    const hostname = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    const hostAllowed =
      hostname === 'localhost' || hostname === '::1' || isIP(hostname) !== 0 || extraHosts.includes(hostname)
    if (!hostAllowed)
      return send(
        403,
        JSON.stringify({ error: { code: 'host_not_allowed', message: '不接受该 Host' } }),
      )
    // 写操作只接受同源页面发起，浏览器里的其他站点不能借本机端口触发写入。
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const site = req.headers['sec-fetch-site']
      const origin = req.headers.origin
      const sameOrigin =
        (!site || site === 'same-origin' || site === 'none') &&
        (!origin || origin.replace(/^https?:\/\//, '') === req.headers.host)
      if (!sameOrigin)
        return send(
          403,
          JSON.stringify({ error: { code: 'cross_origin', message: '只接受同源写入' } }),
        )
    }
    const [path, search] = (req.url || '/').split('?')
    if (path === '/console-config.json' && req.method === 'GET')
      return send(200, JSON.stringify(config))
    if (path.startsWith('/api/')) {
      if (!live)
        return send(404, JSON.stringify({ error: { code: 'not_found', message: '演示模式没有 Runtime 接口' } }))
      const write = req.method !== 'GET' && req.method !== 'HEAD'
      let body = {}
      const text = write ? await readBody(req).catch((e) => e) : ''
      if (text instanceof BridgeError) return fail(text)
      if (text) {
        if (!req.headers['content-type']?.startsWith('application/json'))
          return send(
            415,
            JSON.stringify({ error: { code: 'invalid_request', message: '需要 JSON 请求体' } }),
          )
        try {
          body = JSON.parse(text)
        } catch {
          return send(
            400,
            JSON.stringify({ error: { code: 'invalid_request', message: '请求体不是有效 JSON' } }),
          )
        }
        if (!body || typeof body !== 'object' || Array.isArray(body))
          return send(
            400,
            JSON.stringify({ error: { code: 'invalid_request', message: '请求体必须是对象' } }),
          )
      }
      let request
      try {
        request = route(req.method, path, body, {
          query: new URLSearchParams(search || ''),
        })
      } catch (e) {
        return fail(e)
      }
      if (!request)
        return send(404, JSON.stringify({ error: { code: 'not_found', message: '接口不存在' } }))
      if (active >= MAX_CONCURRENT)
        return send(
          429,
          JSON.stringify({
            error: { code: 'runtime_busy', message: '并发请求过多，请稍后重试' },
          }),
        )
      active++
      try {
        return send(200, JSON.stringify(await callDaemon(socketPath, request.op, request.args)))
      } catch (e) {
        return fail(e)
      } finally {
        active--
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return send(405, JSON.stringify({ error: { code: 'not_found', message: '接口不存在' } }))
    let file, type
    if (path === '/' || path === '/index.html') {
      file = 'index.html'
      type = 'text/html; charset=utf-8'
    } else if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) {
      file = path.slice(1)
      type = file.endsWith('.js') ? 'text/javascript' : 'text/css'
    } else return send(404, JSON.stringify({ error: { code: 'not_found', message: '资源不存在' } }))
    try {
      return send(200, await readFile(new URL(file, dist)), type)
    } catch {
      return send(404, JSON.stringify({ error: { code: 'not_found', message: '资源不存在' } }))
    }
  })
}

async function readBody(req) {
  const chunks = []
  let size = 0
  let tooLarge = false
  // 超限后继续读完请求体，避免提前断开让客户端只看到连接错误。
  for await (const chunk of req) {
    size += chunk.length
    if (size > REQUEST_LIMIT) tooLarge = true
    else chunks.push(chunk)
  }
  if (tooLarge) throw new BridgeError('invalid_request', '请求体过大', 413)
  return Buffer.concat(chunks).toString('utf8')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4181)
  const console_ = await createConsole(process.env)
  const host = process.env.HOST || '0.0.0.0'
  console_.listen(port, host, () =>
    console.log(
      `Ursi Flow 控制台: ${process.env.URSI_FLOW_WEB_TLS_CERT ? 'https' : 'http'}://${host}:${port}/#/flows`,
    ),
  )
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => console_.close(() => process.exit(0)))
}
