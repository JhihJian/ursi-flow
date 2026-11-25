import http from 'node:http'

/**
 * 转发 /api/* 到 dae native API。
 *
 * dae 只监听 loopback 且拒绝外部 Origin，浏览器不能直连，因此由服务端以本机身份访问：
 * 去掉浏览器的来源标记，改写 Host。SSE 响应按流透传，不缓冲。
 */
export function createProxy(apiBase: string) {
  const base = new URL(apiBase)

  return function proxy(req: http.IncomingMessage, res: http.ServerResponse): void {
    const headers: http.OutgoingHttpHeaders = { ...req.headers }
    delete headers.origin
    delete headers.referer
    delete headers.host
    delete headers.cookie
    headers.host = base.host

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
}

/** 服务端自己发起的 dae 调用：无浏览器来源头，返回解析后的 JSON。 */
export async function callDae<T>(
  apiBase: string,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(path, apiBase)
  const body = init.body === undefined ? undefined : JSON.stringify(init.body)
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body,
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  })
  const text = await response.text()
  const parsed = text ? (JSON.parse(text) as unknown) : null
  if (!response.ok) {
    const message =
      (parsed as { error?: { message?: string } } | null)?.error?.message ?? `dae API ${response.status}`
    throw new Error(message)
  }
  return parsed as T
}
