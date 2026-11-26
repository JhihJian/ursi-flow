import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApiHandler } from './api.ts'
import { defaultStateDir } from './config.ts'
import { sendJson } from './http-util.ts'
import { createStaticHandler } from './static.ts'

/**
 * flow-web 服务端：托管静态页面 + 同源 /api（Flow 列表、运行、确认与运行日志）。
 * 数据归属：flow 包留在用户指定的 flow home；运行日志与本服务设置放在状态目录。
 * 部署在可信局域网内，写接口不做来源限制。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = path.resolve(
  process.env.FLOW_WEB_STATIC_DIR ?? path.join(HERE, '..', '..', 'web', 'dist'),
)
const STATE_DIR = defaultStateDir()
const PORT = Number(process.env.FLOW_WEB_PORT ?? 8094)
const HOST = process.env.FLOW_WEB_HOST ?? '0.0.0.0'

const api = createApiHandler(STATE_DIR)
const serveStatic = createStaticHandler(STATIC_DIR)

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok', stateDir: STATE_DIR, staticDir: STATIC_DIR })
    return
  }

  void (async () => {
    const handled = await api(req, res, url.pathname)
    if (!handled) await serveStatic(req, res)
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, 500, { error: { code: 'internal', message } })
  })
})

server.listen(PORT, HOST, () => {
  console.log(`flow-web 监听 ${HOST}:${PORT}`)
  console.log(`静态目录: ${STATIC_DIR}`)
  console.log(`状态目录: ${STATE_DIR}`)
})
