import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'

const dist = new URL('./dist/', import.meta.url)
const hash = (s) => createHash('sha256').update(s).digest()
export function createConsole(env) {
  const {
    URSI_GATEWAY_URL: url,
    URSI_GATEWAY_KEY: key,
    URSI_WEB_PASSWORD: password,
    URSI_WEB_ADMIN_PASSWORD: admin,
  } = env
  const live = Boolean(url || key || password || admin)
  if (
    live &&
    (!url ||
      !key ||
      !(password || admin) ||
      [password, admin].some((p) => p && (p.length < 16 || p === key)) ||
      (admin && admin === password))
  )
    throw Error('真实模式需要 Gateway 地址、密钥和独立的至少 16 位查看密码')
  if (live && !/^https?:$/.test(new URL(url).protocol))
    throw Error('Gateway 地址必须使用 HTTP(S)')
  const adminAuth =
    admin && hash('Basic ' + Buffer.from('admin:' + admin).toString('base64'))
  const auth =
    password &&
    hash('Basic ' + Buffer.from('viewer:' + password).toString('base64'))
  const serve =
    env.URSI_WEB_TLS_CERT || env.URSI_WEB_TLS_KEY
      ? https.createServer.bind(https, {
          cert: readFileSync(env.URSI_WEB_TLS_CERT),
          key: readFileSync(env.URSI_WEB_TLS_KEY),
        })
      : http.createServer
  const sockets = new WebSocketServer({ noServer: true })
  const allowed = (req) => {
    const supplied = hash(req.headers.authorization || '')
    return Boolean(
      (adminAuth && timingSafeEqual(supplied, adminAuth)) ||
      (auth && timingSafeEqual(supplied, auth)),
    )
  }
  const proxyPattern = /^\/api\/v1\/sandboxes\/([a-f0-9]{32})\/proxy\/([A-Za-z0-9_-]+)(\/.*)?$/
  const sameOrigin = (req) => {
    const origin = req.headers.origin
    if (!origin) return true
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }
  const gatewayWs = (id, endpoint) => {
    const target = new URL(`/api/v1/sandboxes/${id}/connect/${endpoint}`, url)
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
    return target
  }
  const openUpstream = (match) =>
    new WebSocket(gatewayWs(match[1], match[2]), 'ursi-tcp-v1', {
      headers: { Authorization: `Bearer ${key}` },
      maxPayload: 64 * 1024,
    })
  const proxyUpgrade = (req, socket, head, match) => {
    if (!live || !allowed(req) || !sameOrigin(req)) return socket.destroy()
    const upstream = openUpstream(match)
    sockets.handleUpgrade(req, socket, head, (browser) => {
      upstream.once('open', () => {
        browser.on('message', (data) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data)
        })
        browser.on('close', () => upstream.close())
        upstream.on('message', (data) => {
          if (browser.readyState === WebSocket.OPEN) browser.send(data)
        })
        upstream.on('close', () => browser.close())
      })
      upstream.on('error', () => browser.close())
    })
  }
  const proxyHttp = (req, res, match) => {
    const upstream = openUpstream(match)
    const chunks = []
    let size = 0
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      if (!chunks.length) return res.writeHead(502).end()
      const raw = Buffer.concat(chunks)
      const split = raw.indexOf(Buffer.from('\r\n\r\n'))
      if (split < 0) return res.writeHead(502).end()
      const head = raw.subarray(0, split).toString('latin1').split('\r\n')
      const status = Number(head.shift()?.split(' ')[1]) || 502
      const headers = {}
      for (const line of head) {
        const separator = line.indexOf(':')
        if (separator < 1) continue
        const name = line.slice(0, separator).toLowerCase()
        if (!['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade'].includes(name))
          headers[name] = line.slice(separator + 1).trim()
      }
      let body = raw.subarray(split + 4)
      if (headers['content-type']?.includes('text/html'))
        body = Buffer.from(body.toString().replaceAll('href="/', 'href="./').replaceAll('src="/', 'src="./'))
      res.writeHead(status, { ...headers, 'Content-Length': body.length })
      res.end(body)
    }
    const timer = setTimeout(() => {
      upstream.close()
      finish()
    }, 10000)
    upstream.on('open', () => {
      const requestPath = match[3] || '/'
      upstream.send(Buffer.from(`GET ${requestPath} HTTP/1.1\r\nHost: sandbox-endpoint\r\nConnection: close\r\nAccept: */*\r\n\r\n`))
      upstream.send('eof')
    })
    upstream.on('message', (data, isBinary) => {
      if (!isBinary) return
      const chunk = Buffer.from(data)
      size += chunk.length
      if (size > 16 * 1024 * 1024) return upstream.close()
      chunks.push(chunk)
    })
    upstream.on('close', () => {
      clearTimeout(timer)
      finish()
    })
    upstream.on('error', () => {
      clearTimeout(timer)
      finish()
    })
  }
  const server = serve(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      })
      res.end(body)
    }
    const supplied = hash(req.headers.authorization || '')
    const manage = Boolean(adminAuth && timingSafeEqual(supplied, adminAuth))
    if (live && !manage && !(auth && timingSafeEqual(supplied, auth))) {
      res.setHeader(
        'WWW-Authenticate',
        'Basic realm="Ursi Sandbox", charset="UTF-8"',
      )
      return send(401, '{}')
    }
    const path = req.url
    const proxy = proxyPattern.exec(path)
    const write = req.method !== 'GET'
    if (!write && path === '/console-config.json')
      return send(
        200,
        JSON.stringify(live ? { mode: 'gateway', manage } : { mode: 'demo' }),
      )
    const collection = '/api/v1/sandboxes'
    if (proxy) {
      if (!live || !allowed(req)) return send(401, '{}')
      if (!sameOrigin(req)) return send(403, '{}')
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, '{}')
      return proxyHttp(req, res, proxy)
    }
    const registry = path === '/api/v1/registry'
    const create = req.method === 'POST' && path === collection
    const rebuild =
      req.method === 'POST' &&
      /^\/api\/v1\/sandboxes\/[a-f0-9]{32}\/rebuild$/.test(path)
    if (write) {
      if (!live || !manage) return send(403, '{}')
      if (
        !(
          create ||
          rebuild ||
          (registry && req.method === 'PUT') ||
          (req.method === 'POST' &&
            /^\/api\/v1\/sandboxes\/[a-f0-9]{32}\/(start|stop)$/.test(path)) ||
          (req.method === 'DELETE' &&
            /^\/api\/v1\/sandboxes\/[a-f0-9]{32}$/.test(path))
        )
      )
        return send(405, '{}')
      // Custom header forces a CORS preflight; this server never grants cross-origin requests.
      if (
        req.headers['x-ursi-action'] !== 'manage' ||
        req.headers['sec-fetch-site'] === 'cross-site'
      )
        return send(403, '{}')
    }
    if (
      live &&
      (write ||
        path === '/api/v1/capabilities' ||
        registry ||
        /^\/api\/v1\/sandboxes(?:\/[a-f0-9]{32}(?:\/logs\?tail=200|\/endpoints)?)?$/.test(
          path,
        ))
    ) {
      try {
        const headers = { Authorization: `Bearer ${key}` }
        let body
        if (create || rebuild || (registry && req.method === 'PUT')) {
          if (req.headers['content-type'] !== 'application/json')
            return send(415, '{}')
          const chunks = []
          let size = 0
          for await (const chunk of req) {
            size += chunk.length
            if (size > 128 * 1024) return send(413, '{}')
            chunks.push(chunk)
          }
          body = Buffer.concat(chunks)
          headers['Content-Type'] = 'application/json'
          if (create) {
            const idem = req.headers['idempotency-key']
            if (typeof idem !== 'string' || !/^[a-f0-9]{32}$/.test(idem))
              return send(400, '{}')
            headers['Idempotency-Key'] = idem
          }
        }
        const r = await fetch(new URL(path, url), {
          method: req.method,
          body,
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        })
        const result = await r.json().catch(() => ({}))
        return send(
          r.status,
          r.ok
            ? JSON.stringify(result)
            : JSON.stringify({
                error: {
                  message: String(result?.error?.message || '')
                    .replaceAll(key, '[已隐藏]')
                    .slice(0, 512),
                },
              }),
        )
      } catch {
        return send(502, '{}')
      }
    }
    let file, type
    if (/^\/sandboxes(?:\/[a-f0-9]{32})?\/?$/.test(path)) {
      res.setHeader('Location', '/#' + path)
      return send(302, '{}')
    }
    if (path === '/' || path === '/index.html') {
      file = 'index.html'
      type = 'text/html; charset=utf-8'
    } else if (/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) {
      file = path.slice(1)
      type = file.endsWith('.js') ? 'text/javascript' : 'text/css'
    } else return send(404, '{}')
    try {
      return send(200, await readFile(new URL(file, dist)), type)
    } catch {
      return send(404, '{}')
    }
  })
  server.on('upgrade', (req, socket, head) => {
    const match = proxyPattern.exec(req.url || '')
    if (!match) return socket.destroy()
    proxyUpgrade(req, socket, head, match)
  })
  return server
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.PORT || 4180)
  const host =
    process.env.URSI_WEB_ADMIN_PASSWORD && !process.env.URSI_WEB_TLS_CERT
      ? '127.0.0.1'
      : '0.0.0.0'
  createConsole(process.env).listen(port, host, () =>
    console.log(
      `Ursi Sandbox: ${process.env.URSI_WEB_TLS_CERT ? 'https' : 'http'}://${host}:${port}/sandboxes`,
    ),
  )
}
