import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConsoleHandler } from './console.ts'
import { createConfigStore, defaultBackupDir } from './daemon-config.ts'
import { isLoopback, sendError, sendJson } from './http-util.ts'
import { createProxy } from './proxy.ts'
import { createStaticHandler } from './static.ts'

/**
 * dae-web 服务端：托管构建产物，转发 /api/* 给 dae native API，
 * 并在 /console/* 上提供本服务自己的控制面（配置文件读写）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = path.resolve(
  process.env.DAE_WEB_STATIC_DIR ?? path.join(HERE, '..', '..', 'web', 'dist'),
)
const API_BASE = process.env.DAE_API_BASE ?? 'http://127.0.0.1:9527'
const CONFIG_PATH = process.env.DAE_CONFIG_PATH ?? '/etc/dae/config.dae'
const PORT = Number(process.env.DAE_WEB_PORT ?? 8092)
const HOST = process.env.DAE_WEB_HOST ?? '0.0.0.0'

/** dae 的写操作（关连接、清缓存）只允许本机浏览器，回环外部看只读视图。 */
const READ_ONLY_SAFE_PATHS = new Set(['/api/v1/routing/trace'])

function mutationAllowed(req: http.IncomingMessage): boolean {
  if (process.env.DAE_WEB_ALLOW_MUTATIONS === '1') return true
  const method = req.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD') return true
  if (READ_ONLY_SAFE_PATHS.has((req.url ?? '').split('?')[0])) return true
  return isLoopback(req.socket.remoteAddress)
}

const proxy = createProxy(API_BASE)
const serveStatic = createStaticHandler(STATIC_DIR)
const store = createConfigStore({ apiBase: API_BASE, filePath: CONFIG_PATH, backupDir: defaultBackupDir() })
const handleConsole = createConsoleHandler(store)

const server = http.createServer((req, res) => {
  const url = req.url ?? '/'

  if (url === '/healthz') {
    // console 表示本连接能否读写配置文件，前端据此决定是否显示配置分区。
    const consoleAllowed = isLoopback(req.socket.remoteAddress)
    sendJson(res, 200, {
      status: 'ok',
      api: API_BASE,
      config: CONFIG_PATH,
      console: consoleAllowed,
    })
    return
  }

  if (url.startsWith('/console/')) {
    // 配置写入只能由本机发起，局域网只有观测视图。
    if (!isLoopback(req.socket.remoteAddress) && process.env.DAE_WEB_ALLOW_MUTATIONS !== '1') {
      sendError(res, 403, 'read_only', '配置的读取与写入只能从本机发起')
      return
    }
    void handleConsole(req, res)
    return
  }

  if (url.startsWith('/api/')) {
    if (!mutationAllowed(req)) {
      sendError(res, 403, 'read_only', '本机以外的访问只提供只读视图')
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
  console.log(`配置文件 ${CONFIG_PATH}`)
})
