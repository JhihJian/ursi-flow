import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConsoleHandler } from './console.ts'
import { createConfigService } from './daemon-config.ts'
import { isLoopback, sendError, sendJson } from './http-util.ts'
import { createDaeClient } from './proxy.ts'
import { createStaticHandler } from './static.ts'

/**
 * dae-web 服务端：托管构建产物，转发 /api/* 给 dae native API（注入 Bearer token），
 * 并在 /console/* 上提供配置页所需的编排。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = path.resolve(
  process.env.DAE_WEB_STATIC_DIR ?? path.join(HERE, '..', '..', 'web', 'dist'),
)
const API_BASE = process.env.DAE_API_BASE ?? 'http://127.0.0.1:9527'
const CONFIG_PATH = process.env.DAE_CONFIG_PATH ?? '/etc/dae/config.dae'
const PORT = Number(process.env.DAE_WEB_PORT ?? 8092)
const HOST = process.env.DAE_WEB_HOST ?? '0.0.0.0'

/** 只读路径：局域网也可以访问。其余非 GET 请求只允许回环来源。 */
const READ_ONLY_SAFE_PATHS = new Set(['/api/v1/routing/trace'])

/** 配置内容可能含节点凭据，读与写都只对本机开放。 */
function isConfigPath(url: string): boolean {
  const pathname = url.split('?')[0]
  return pathname.startsWith('/api/v1/config') || pathname.startsWith('/console/')
}

function writeAllowed(req: http.IncomingMessage): boolean {
  if (process.env.DAE_WEB_ALLOW_MUTATIONS === '1') return true
  const method = req.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD') return true
  if (READ_ONLY_SAFE_PATHS.has((req.url ?? '').split('?')[0])) return true
  return isLoopback(req.socket.remoteAddress)
}

// token 来自 EnvironmentFile（0600），不落代码库、不进命令行。
const token = process.env.DAE_API_TOKEN?.trim() || null
if (!token) {
  console.warn('未设置 DAE_API_TOKEN：dae 会拒绝全部请求（401）。')
}

const dae = createDaeClient(API_BASE, token)
const config = createConfigService(dae, CONFIG_PATH)
const handleConsole = createConsoleHandler(config)
const serveStatic = createStaticHandler(STATIC_DIR)

const server = http.createServer((req, res) => {
  const url = req.url ?? '/'
  const loopback = isLoopback(req.socket.remoteAddress)

  if (url === '/healthz') {
    sendJson(res, 200, {
      status: 'ok',
      api: API_BASE,
      config: CONFIG_PATH,
      // console 表示本连接能否读写配置，前端据此决定是否显示配置分区。
      console: loopback || process.env.DAE_WEB_ALLOW_MUTATIONS === '1',
      token: Boolean(token),
    })
    return
  }

  if (isConfigPath(url) && !loopback && process.env.DAE_WEB_ALLOW_MUTATIONS !== '1') {
    sendError(res, 403, 'read_only', '配置的读取与写入只能从本机发起')
    return
  }

  if (url.startsWith('/console/')) {
    void handleConsole(req, res)
    return
  }

  if (url.startsWith('/api/')) {
    if (!writeAllowed(req)) {
      sendError(res, 403, 'read_only', '本机以外的访问只提供只读视图')
      return
    }
    dae.proxy(req, res)
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
  console.log(`转发 /api -> ${API_BASE}（token ${token ? '已加载' : '缺失'}）`)
  console.log(`配置文件入口 ${CONFIG_PATH}`)
})
