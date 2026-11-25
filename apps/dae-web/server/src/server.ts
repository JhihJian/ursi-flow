import http from 'node:http'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * dae-web 服务端：托管构建产物，并把 /api/* 原样转发给本机 dae 的 native API。
 *
 * dae 只监听 loopback，且会拒绝带外部 Origin 的请求，所以浏览器不能直连；
 * 这里由服务端发起无 Origin 的转发，前端再以同源方式访问。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = path.resolve(
  process.env.DAE_WEB_STATIC_DIR ?? path.join(HERE, '..', '..', 'web', 'dist'),
)
const API_BASE = process.env.DAE_API_BASE ?? 'http://127.0.0.1:9527'
const PORT = Number(process.env.DAE_WEB_PORT ?? 8092)
const HOST = process.env.DAE_WEB_HOST ?? '0.0.0.0'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/** dae 的写操作（关连接、清缓存）只允许本机浏览器，回环外部看只读视图。 */
const MUTATING_PATHS = new Set(['/api/v1/routing/trace'])

function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.')
}

function mutationAllowed(req: http.IncomingMessage): boolean {
  if (process.env.DAE_WEB_ALLOW_MUTATIONS === '1') return true
  const method = req.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD') return true
  if (MUTATING_PATHS.has((req.url ?? '').split('?')[0])) return true
  return isLoopback(req.socket.remoteAddress)
}

/** 转发到 dae。请求体与响应体都按流处理，SSE（logs、events）因此可以直接透传。 */
function proxy(req: http.IncomingMessage, res: http.ServerResponse): void {
  const base = new URL(API_BASE)
  const headers: http.OutgoingHttpHeaders = { ...req.headers }
  // dae 只认自身可信来源：去掉浏览器的来源标记，由服务端按本机身份访问。
  delete headers.origin
  delete headers.referer
  delete headers.host
  delete headers.cookie
  headers.host = base.host

  const upstream = http.request(
    {
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port,
      method: req.method,
      path: req.url ?? '/',
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )

  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        error: { code: 'upstream_unavailable', message: `dae API 不可达：${message}` },
      }),
    )
  })

  // 客户端提前断开时中止上游；不能用 req 的 close 事件，GET 请求体一结束它就会触发。
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

/** 静态文件：命中目录或扩展名缺失时回退 index.html，其余缺失按 404 处理。 */
async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    res.writeHead(400).end('bad request')
    return
  }

  const target = path.resolve(STATIC_DIR, `.${pathname}`)
  if (target !== STATIC_DIR && !target.startsWith(`${STATIC_DIR}${path.sep}`)) {
    res.writeHead(403).end('forbidden')
    return
  }

  let file = target
  try {
    const info = await fs.stat(file)
    if (info.isDirectory()) file = path.join(file, 'index.html')
  } catch {
    file = path.join(STATIC_DIR, 'index.html')
  }

  const ext = path.extname(file)
  try {
    const info = await fs.stat(file)
    if (!info.isFile()) throw new Error('not a file')
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': file.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    })
    createReadStream(file).pipe(res)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found')
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ status: 'ok', api: API_BASE }))
    return
  }
  if ((req.url ?? '').startsWith('/api/')) {
    if (!mutationAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          error: { code: 'read_only', message: '本机以外的访问只提供只读视图' },
        }),
      )
      return
    }
    proxy(req, res)
    return
  }
  void serveStatic(req, res)
})

// SSE 长连接不应被 HTTP 层的 keep-alive 超时截断。
server.setTimeout(0)
server.headersTimeout = 0
server.requestTimeout = 0

server.listen(PORT, HOST, () => {
  console.log(`dae-web 运行在 http://${HOST}:${PORT}`)
  console.log(`静态目录 ${STATIC_DIR}`)
  console.log(`转发 /api -> ${API_BASE}`)
})
