import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const dist = new URL('./dist/', import.meta.url)
const hash = (s) => createHash('sha256').update(s).digest()
export function createConsole(env) {
  const {
    URSI_GATEWAY_URL: url,
    URSI_GATEWAY_KEY: key,
    URSI_WEB_PASSWORD: password,
  } = env
  const live = Boolean(url || key || password)
  if (
    live &&
    (!url || !key || !password || password.length < 16 || password === key)
  )
    throw Error('真实模式需要 Gateway 地址、密钥和独立的至少 16 位查看密码')
  if (live && !/^https?:$/.test(new URL(url).protocol))
    throw Error('Gateway 地址必须使用 HTTP(S)')
  const auth =
    live &&
    hash('Basic ' + Buffer.from('viewer:' + password).toString('base64'))
  return http.createServer(async (req, res) => {
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
    if (req.method !== 'GET') return send(405, '{}')
    if (live && !timingSafeEqual(hash(req.headers.authorization || ''), auth)) {
      res.setHeader(
        'WWW-Authenticate',
        'Basic realm="Ursi Sandbox", charset="UTF-8"',
      )
      return send(401, '{}')
    }
    const path = req.url
    if (path === '/console-config.json')
      return send(200, JSON.stringify({ mode: live ? 'gateway' : 'demo' }))
    // Exact allowlist: never accept an upstream URL, tunnel, redirect or write method from the browser.
    if (
      /^\/api\/v1\/sandboxes(?:\/[a-f0-9]{32}(?:\/logs\?tail=200)?)?$/.test(
        path,
      ) &&
      live
    ) {
      try {
        const r = await fetch(new URL(path, url), {
          headers: { Authorization: `Bearer ${key}` },
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        })
        return send(r.status, r.ok ? JSON.stringify(await r.json()) : '{}')
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
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.PORT || 4180)
  createConsole(process.env).listen(port, '0.0.0.0', () =>
    console.log(`Ursi Sandbox: http://localhost:${port}/sandboxes`),
  )
}
