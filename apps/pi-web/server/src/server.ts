import http from 'node:http'
import { HOST, PORT, STATIC_DIR } from './config.ts'
import { ensureStateDir, statePaths } from './state.ts'
import { createApiHandler } from './http/router.ts'
import { createStaticHandler } from './http/static.ts'
import { sendJson } from './http/respond.ts'
import { defaultHomeIfValid } from './shared/pi-home.ts'
import { homes } from './config/registry.ts'
import { createSessionService } from './sessions/service.ts'
import { setSessionRuntime, setSessionService } from './sessions/routes.ts'
import { sweepExternalRoots } from './sessions/registry.ts'
import { chatTranscript, createChat, disposeAllChats } from './runtime/chat.ts'
import { startHeartbeatSync } from './runtime/live-sessions.ts'
import { startSessionTask } from './runtime/session-task.ts'
import './config/routes.ts'
import './sessions/routes.ts'
import './runtime/routes.ts'

/**
 * pi-web 服务端：一个进程托管配置、会话浏览与对话运行时。
 *
 * 四个域：`config/` 文件级配置、`sessions/` 磁盘事实（扫描、轨迹文件、删除、偏好、
 * 外部根）、`runtime/` 活会话（装配、turn、SSE、中止、模型切换、交互、释放、心跳、
 * 运行时事实投影）、`facts/` 纯提取。后三者共用 `sessions/registry.ts` 这一份会话
 * 实体表，接口只读写实体，不再各自维护列表。
 *
 * 本文件是组合根：会话域要的运行时能力在这里接线，两个域不互相 import。
 */

ensureStateDir()
const service = await createSessionService()
setSessionService(service)
setSessionRuntime({ createChat, startSessionTask, chatTranscript })

const api = createApiHandler()
const serveStatic = createStaticHandler(STATIC_DIR)

/** 外部根 LRU 的定期回收：与请求无关，避免切目录后扫描面无限膨胀。 */
const sweeper = setInterval(() => sweepExternalRoots(), 60_000)
sweeper.unref()

/** 跨进程心跳的定期合流：会话清单只读，刷新运行态由运行时域按节拍做。 */
const stopHeartbeatSync = startHeartbeatSync()

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
    // 顺序：先停心跳与 SSE 订阅者（否则 server.close() 会挂住），再释放对话、落索引。
    void (async () => {
      stopHeartbeatSync()
      await disposeAllChats()
      service.flush()
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 1500).unref()
    })()
  })
}
