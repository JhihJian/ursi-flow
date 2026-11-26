import type http from 'node:http'
import { sendError, sendJson, readBody } from './respond.ts'
import { BODY_LIMIT } from '../config.ts'
import { ConflictError } from '../shared/rw.ts'
import { HomeError, resolveRequestedHome } from '../shared/pi-home.ts'

/**
 * 路由层：一张表 + 段匹配 + 每条路由声明 home 策略。
 *
 * 旧的「最长前缀 + selfResolved 白名单」会把 `/api/sessions/config` 当成会话 id，
 * 也漏一条白名单就 400。这里固定段优先于 `:param` 段，home 由路由自己声明。
 */

export type HomePolicy = 'required' | 'optional' | 'none'

export interface RouteContext {
  /** `required` / `optional` 时是 realpath 后的 home；`none` 时为空串。 */
  home: string
  params: Record<string, string>
  url: URL
  req: http.IncomingMessage
  res: http.ServerResponse
  body: <T>() => Promise<T>
}

/** handler 自己接管响应（SSE、202、gzip 流）时返回它，路由层不再写 JSON。 */
export const HANDLED = Symbol('handled')

type Handler = (ctx: RouteContext) => Promise<unknown>

interface RegisteredRoute {
  method: string
  pattern: string
  segments: string[]
  policy: HomePolicy
  handler: Handler
}

const ROUTES: RegisteredRoute[] = []

export function route(
  method: string,
  pattern: string,
  policy: HomePolicy,
  handler: Handler,
): void {
  ROUTES.push({
    method,
    pattern,
    segments: pattern.split('/').filter(Boolean),
    policy,
    handler,
  })
}

/** 段匹配：`:` 开头的段是参数，其余按字面比较。 */
function matchSegments(pattern: string[], path: string[]): Record<string, string> | null {
  if (pattern.length !== path.length) return null
  const params: Record<string, string> = {}
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]
    const actual = path[index]
    if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual)
    else if (expected !== actual) return null
  }
  return params
}

/** 字面段越多越具体：`/api/sessions/prefs` 胜过 `/api/sessions/:id`。 */
function specificity(segments: string[]): number {
  return segments.filter((segment) => !segment.startsWith(':')).length
}

function findRoute(method: string, path: string[]): { route: RegisteredRoute; params: Record<string, string> } | null {
  const candidates = ROUTES.filter((item) => item.method === method)
    .map((item) => ({ route: item, params: matchSegments(item.segments, path) }))
    .filter((item): item is { route: RegisteredRoute; params: Record<string, string> } => item.params !== null)
    .sort((a, b) => specificity(b.route.segments) - specificity(a.route.segments))
  return candidates[0] ?? null
}

export function createApiHandler(): (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
) => Promise<boolean> {
  return async (req, res, pathname) => {
    if (!pathname.startsWith('/api/')) return false
    const url = new URL(req.url ?? '/', 'http://localhost')
    const segments = pathname.split('/').filter(Boolean)

    try {
      const match = findRoute(req.method ?? 'GET', segments)
      if (!match) {
        // 未命中的 API 一律 JSON 404，绝不落到静态兜底返回 index.html。
        sendError(res, 404, 'not_found', `未知 API：${req.method} ${pathname}`)
        return true
      }
      const { route: registered, params } = match
      const home =
        registered.policy === 'none'
          ? ''
          : registered.policy === 'optional' && !url.searchParams.get('home')
            ? ''
            : await resolveRequestedHome(url.searchParams.get('home'))
      const result = await registered.handler({
        home,
        params,
        url,
        req,
        res,
        body: async <T,>() => {
          const text = await readBody(req, BODY_LIMIT)
          return JSON.parse(text) as T
        },
      })
      if (result === HANDLED) return true
      if (res.headersSent) return true
      sendJson(res, 200, result)
      return true
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return true
      }
      if (error instanceof HomeError) {
        sendError(res, error.status, error.code, error.message)
      } else if (error instanceof ConflictError) {
        sendError(res, 409, 'conflict', error.message)
      } else if (error instanceof SyntaxError) {
        sendError(res, 400, 'bad_json', '请求体不是合法 JSON')
      } else {
        const message = error instanceof Error ? error.message : String(error)
        const status = /ENOENT|不存在/.test(message) ? 404 : 500
        sendError(res, status, 'internal', message)
      }
      return true
    }
  }
}
