import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

/**
 * 转发 /api/* 到 dae native API。
 *
 * dae 只监听 loopback、拒绝外部 Origin，且启用 api.secret 后要求 Bearer token。
 * 浏览器不能直连，也不该拿到 token，因此由服务端统一注入：
 * 去掉浏览器的来源头，改写 Host，补上 Authorization。
 * SSE 响应按流透传，不缓冲。
 */

interface DaeFailure extends Error {
  code?: string
  status?: number
}

export interface DaeAuth {
  /** 直接给出的 token，优先使用。 */
  token?: string
  /** token 文件路径，文件内容去掉首尾空白后作为 token。 */
  tokenFile?: string
}

export async function loadToken(auth: DaeAuth): Promise<string | null> {
  if (auth.token) return auth.token
  if (!auth.tokenFile) return null
  try {
    const raw = await fs.readFile(auth.tokenFile, 'utf8')
    const token = raw.trim()
    return token || null
  } catch {
    return null
  }
}

export function defaultTokenFile(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
  return path.join(base, 'dae-web', 'api-token')
}

export interface DaeClient {
  proxy: (req: http.IncomingMessage, res: http.ServerResponse) => void
  call: <T>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number }) => Promise<T>
}

export function createDaeClient(apiBase: string, token: string | null): DaeClient {
  const base = new URL(apiBase)

  function authHeaders(): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {}
  }

  function proxy(req: http.IncomingMessage, res: http.ServerResponse): void {
    const headers: http.OutgoingHttpHeaders = { ...req.headers }
    delete headers.origin
    delete headers.referer
    delete headers.host
    delete headers.cookie
    // 客户端自带的 Authorization 一律丢掉，只用服务端持有的 token。
    delete headers.authorization
    headers.host = base.host
    if (token) headers.authorization = `Bearer ${token}`

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

  async function call<T>(
    apiPath: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<T> {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body)
    const response = await fetch(new URL(apiPath, apiBase), {
      method: init.method ?? 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(),
        ...init.headers,
      },
      body,
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    })
    const text = await response.text()
    const parsed = text ? (JSON.parse(text) as unknown) : null
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error
      const failure = new Error(error?.message ?? `dae API ${response.status}`) as DaeFailure
      failure.code = error?.code
      failure.status = response.status
      throw failure
    }
    return parsed as T
  }

  return { proxy, call }
}
