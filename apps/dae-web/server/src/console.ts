import type http from 'node:http'
import { ConfigError, type ConfigService } from './daemon-config.ts'
import { readBody, sendError, sendJson } from './http-util.ts'

/**
 * /console/* 是本服务对配置页的封装：
 * 读取所有配置源、按源校验、按源保存并等待 dae 应用。
 * 真正的写入与热加载由 dae 完成，这里只负责 token 注入后的编排。
 */
export function createConsoleHandler(config: ConfigService) {
  const bodyLimit = 256 * 1024

  return async function handleConsole(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'

    try {
      if (url.pathname === '/console/config' && (method === 'GET' || method === 'HEAD')) {
        sendJson(res, 200, await config.readSnapshot())
        return
      }

      if (url.pathname === '/console/config/check' && method === 'POST') {
        const body = JSON.parse(await readBody(req, bodyLimit)) as {
          sourcePath?: string
          content?: string
        }
        if (typeof body.sourcePath !== 'string' || typeof body.content !== 'string') {
          sendError(res, 400, 'invalid_request', 'sourcePath 与 content 必须是字符串')
          return
        }
        sendJson(res, 200, await config.check(body.sourcePath, body.content))
        return
      }

      if (url.pathname === '/console/config/apply' && method === 'POST') {
        const body = JSON.parse(await readBody(req, bodyLimit)) as {
          sourcePath?: string
          content?: string
          expectedSha256?: string
        }
        if (
          typeof body.sourcePath !== 'string' ||
          typeof body.content !== 'string' ||
          typeof body.expectedSha256 !== 'string'
        ) {
          sendError(res, 400, 'invalid_request', 'sourcePath、content 与 expectedSha256 必须是字符串')
          return
        }
        sendJson(res, 200, await config.apply(body.sourcePath, body.content, body.expectedSha256))
        return
      }

      sendError(res, 404, 'resource_not_found', '资源不存在')
    } catch (error) {
      if (error instanceof ConfigError) {
        sendError(res, error.status, 'config_operation_failed', error.message)
        return
      }
      sendError(
        res,
        502,
        'config_operation_failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}
