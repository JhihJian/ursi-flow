import type http from 'node:http'
import type { ConfigStore } from './daemon-config.ts'
import { readBody, sendError, sendJson } from './http-util.ts'

/**
 * /console/* 是本服务自己的控制面，与 dae 的 /api/v1 分开：
 * 配置文件的读取、校验、保存与回滚由本服务编排。
 */
export function createConsoleHandler(store: ConfigStore) {
  const bodyLimit = 256 * 1024

  return async function handleConsole(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'

    try {
      if (url.pathname === '/console/config' && (method === 'GET' || method === 'HEAD')) {
        sendJson(res, 200, await store.snapshot())
        return
      }

      if (url.pathname === '/console/config/check' && method === 'POST') {
        const body = JSON.parse(await readBody(req, bodyLimit)) as { content?: string }
        if (typeof body.content !== 'string') {
          sendError(res, 400, 'invalid_request', 'content 必须是字符串')
          return
        }
        sendJson(res, 200, await store.check(body.content))
        return
      }

      if (url.pathname === '/console/config/apply' && method === 'POST') {
        const body = JSON.parse(await readBody(req, bodyLimit)) as {
          content?: string
          expectedSha256?: string | null
        }
        if (typeof body.content !== 'string') {
          sendError(res, 400, 'invalid_request', 'content 必须是字符串')
          return
        }
        const result = await store.apply(body.content, body.expectedSha256 ?? null)
        sendJson(res, 200, { ok: true, ...result })
        return
      }

      if (url.pathname === '/console/config/restore' && method === 'POST') {
        const body = JSON.parse(await readBody(req, bodyLimit)) as { backup?: string }
        if (typeof body.backup !== 'string') {
          sendError(res, 400, 'invalid_request', 'backup 必须是字符串')
          return
        }
        const result = await store.restore(body.backup)
        sendJson(res, 200, { ok: true, ...result })
        return
      }

      sendError(res, 404, 'resource_not_found', '资源不存在')
    } catch (error) {
      sendError(res, 400, 'config_operation_failed', error instanceof Error ? error.message : String(error))
    }
  }
}
