import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { attachWorkbench } from './workbench.mjs'

const dist = new URL('./dist/', import.meta.url)
const hash = (s) => createHash('sha256').update(s).digest()
export function createConsole(env) {
  const {
    URSI_GATEWAY_URL: url,
    URSI_GATEWAY_KEY: key,
    URSI_WEB_PASSWORD: password,
    URSI_WEB_ADMIN_PASSWORD: admin,
  } = env
  if (
    !url ||
    !key ||
    !(password || admin) ||
    [password, admin].some((p) => p && (p.length < 16 || p === key)) ||
    (admin && admin === password)
  )
    throw Error('控制台需要 Gateway 地址、密钥和至少一个独立的 Web 密码（至少 16 字符）')
  if (!/^https?:$/.test(new URL(url).protocol))
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
  const isAdmin = (req) => Boolean(adminAuth && timingSafeEqual(hash(req.headers.authorization || ''), adminAuth))
  const server = serve(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      })
      res.end(body)
    }
    const supplied = hash(req.headers.authorization || '')
    const manage = Boolean(adminAuth && timingSafeEqual(supplied, adminAuth))
    if (!manage && !(auth && timingSafeEqual(supplied, auth))) {
      res.setHeader(
        'WWW-Authenticate',
        'Basic realm="Ursi Sandbox", charset="UTF-8"',
      )
      return send(401, '{}')
    }
    const path = req.url
    const write = req.method !== 'GET'
    if (!write && path === '/console-config.json')
      return send(
        200,
        JSON.stringify({ mode: 'gateway', manage, ...(manage ? { sshSandboxes: workbench.sshSandboxes } : {}) }),
      )
    const collection = '/api/v1/sandboxes'
    const registry = path === '/api/v1/registry'
    const create = req.method === 'POST' && path === collection
    const rebuild =
      req.method === 'POST' &&
      /^\/api\/v1\/sandboxes\/[a-f0-9]{32}\/rebuild$/.test(path)
    if (write) {
      if (!manage) return send(403, '{}')
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
      write ||
      path === '/api/v1/capabilities' ||
      registry ||
      /^\/api\/v1\/sandboxes(?:\/[a-f0-9]{32}(?:\/logs\?tail=200|\/endpoints)?)?$/.test(
        path,
      )
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
  const workbench = attachWorkbench(server, { env, url, key, isAdmin })
  return server
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.PORT || 4180)
  const host = process.env.URSI_WEB_TLS_CERT ? '0.0.0.0' : '127.0.0.1'
  createConsole(process.env).listen(port, host, () =>
    console.log(
      `Ursi Sandbox: ${process.env.URSI_WEB_TLS_CERT ? 'https' : 'http'}://${host}:${port}/sandboxes`,
    ),
  )
}
