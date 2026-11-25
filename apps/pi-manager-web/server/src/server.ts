import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApiHandler } from './api.ts'
import { createStaticHandler } from './static.ts'
import { sendJson } from './http-util.ts'
import { defaultHomeIfValid } from './pi-home.ts'

/**
 * pi-manager-web 服务端：托管静态页面 + 同源 /api（文件级 pi home 配置管理）。
 * 写操作只对回环来源开放（api.ts 内执行），凭据字段永不原样回传。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = path.resolve(
  process.env.PI_MANAGER_STATIC_DIR ?? path.join(HERE, '..', '..', 'web', 'dist'),
)
const PORT = Number(process.env.PI_MANAGER_PORT ?? 8093)
const HOST = process.env.PI_MANAGER_HOST ?? '0.0.0.0'

const api = createApiHandler()
const serveStatic = createStaticHandler(STATIC_DIR)

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname

  if (pathname === '/healthz') {
    sendJson(res, 200, {
      status: 'ok',
      defaultHome: defaultHomeIfValid(),
      writePolicy: 'loopback-only',
    })
    return
  }

  void (async () => {
    const handled = await api(req, res, pathname)
    if (!handled) await serveStatic(req, res)
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { code: 'internal', message } }))
  })
})

server.listen(PORT, HOST, () => {
  console.log(`pi-manager-web 监听 ${HOST}:${PORT}`)
  console.log(`静态目录: ${STATIC_DIR}`)
  console.log(`默认 pi home: ${defaultHomeIfValid() ?? '（默认位置没有找到 pi home）'}`)
})
