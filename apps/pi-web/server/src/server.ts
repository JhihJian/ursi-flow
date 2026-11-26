import http from 'node:http'
import { HOST, PORT, STATIC_DIR } from './config.ts'
import { ensureStateDir, statePaths } from './state.ts'
import { createApiHandler } from './http/router.ts'
import { createStaticHandler } from './http/static.ts'
import { sendJson } from './http/respond.ts'
import { defaultHomeIfValid } from './shared/pi-home.ts'
import { homes } from './config/registry.ts'
import { createSessionService } from './sessions/service.ts'
import { setSessionService } from './sessions/routes.ts'
import { sweepExternalRoots } from './sessions/registry.ts'
import './config/routes.ts'
import './sessions/routes.ts'

/**
 * pi-web 服务端：一个进程托管配置、对话运行时、会话浏览与独立页面。
 *
 * 域划分：`config/` 文件级配置、`chat/` 常驻运行时与一次性任务、`sessions/`
 * 扫描与轨迹。三者共用 `sessions/registry.ts` 这一份会话实体表，
 * 接口只读写实体，不再各自维护列表。
 */

ensureStateDir()
const service = await createSessionService()
setSessionService(service)

const api = createApiHandler()
const serveStatic = createStaticHandler(STATIC_DIR)

/** 外部根 LRU 的定期回收：与请求无关，避免切目录后扫描面无限膨胀。 */
const sweeper = setInterval(() => sweepExternalRoots(), 60_000)
sweeper.unref()

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname

  if (pathname === '/healthz' || pathname === '/api/health') {
    sendJson(res, 200, {
      status: 'ok',
      defaultHome: defaultHomeIfValid(),
      writePolicy: 'trusted-lan',
      stateDir: statePaths().root,
      homes: homes.list().length,
    })
    return
  }

  void (async () => {
    const handled = await api(req, res, pathname)
    if (!handled) await serveStatic(req, res)
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { code: 'internal', message } }))
    }
  })
})

server.listen(PORT, HOST, () => {
  console.log(`pi-web 监听 ${HOST}:${PORT}`)
  console.log(`静态目录: ${STATIC_DIR}`)
  console.log(`状态目录: ${statePaths().root}`)
  console.log(`默认 pi home: ${defaultHomeIfValid() ?? '（默认位置没有找到 pi home）'}`)
})

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    // 顺序：先摘 SSE 订阅者（否则 server.close() 会挂住），再释放对话、落索引。
    void (async () => {
      const { disposeAllChats } = await import('./chat/chat.ts')
      await disposeAllChats()
      service.flush()
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 1500).unref()
    })()
  })
}
