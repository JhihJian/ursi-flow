import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { createGzip } from 'node:zlib'
import { createTransformer, detectFormat } from './canonicalize.mjs'
import { loadConfig } from './config.mjs'
import { createLocator, SESSION_ID } from './locate.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

const json = (response, status, body, headers = {}) => {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  })
  response.end(text)
}

const text = (response, status, body, headers = {}) => {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers })
  response.end(body)
}

/**
 * 只读开头若干行，凑齐格式判断与会话头信息。
 * 老写法里 `cwd`/`sessionId` 不在第一行，必须多看几行。
 */
async function peek(path, maxLines = 50) {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const hints = { format: 'unknown', cwd: null, sessionId: null, timestamp: null }
  let seen = 0
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      seen += 1
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (hints.format === 'unknown') hints.format = detectFormat(row)
      hints.cwd ??= typeof row.cwd === 'string' ? row.cwd : null
      hints.sessionId ??= typeof row.sessionId === 'string' ? row.sessionId : null
      hints.timestamp ??= typeof row.timestamp === 'string' ? row.timestamp : null
      if (seen >= maxLines && hints.format !== 'unknown' && hints.cwd) break
      if (seen >= maxLines) break
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return hints
}

/**
 * 只读服务：按 sessionId 定位文件、给出元信息、把内容转换成组件库可解析的形状。
 * 解析与渲染都在浏览器里由组件库完成，这里不做分页。
 */
export function createApp(config = loadConfig()) {
  const locator = createLocator({ roots: config.roots, ttlMs: config.indexTtlMs })

  const authorized = (request, url) => {
    if (!config.token) return true
    if (request.headers.authorization === `Bearer ${config.token}`) return true
    return url.searchParams.get('token') === config.token
  }

  const findSession = async (id) => {
    if (!SESSION_ID.test(String(id ?? ''))) return { error: [400, 'Invalid session id'] }
    const record = await locator.find(id)
    if (!record) return { error: [404, 'Session not found'] }
    return { record }
  }

  const serveStatic = async (request, response, pathname) => {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const candidates = [join(config.staticDir, normalize(relative))]
    if (!extname(relative)) candidates.push(join(config.staticDir, 'index.html'))

    for (const file of candidates) {
      if (!file.startsWith(config.staticDir)) continue
      try {
        const info = await stat(file)
        if (!info.isFile()) continue
        const body = await readFile(file)
        response.writeHead(200, {
          'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
          'Content-Length': body.length,
          'Cache-Control': extname(file) === '.html' ? 'no-store' : 'public, max-age=3600',
          ...(config.frameAncestors
            ? { 'Content-Security-Policy': `frame-ancestors ${config.frameAncestors}` }
            : {}),
        })
        response.end(body)
        return true
      } catch {
        continue
      }
    }
    return false
  }

  return async function handle(request, response) {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`)
    const { pathname } = url

    if (pathname === '/api/health') return text(response, 200, 'ok')
    if (pathname.startsWith('/api/') && !authorized(request, url)) {
      return json(response, 401, { error: 'Unauthorized' })
    }

    const textMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/text$/)
    if (textMatch) {
      const found = await findSession(textMatch[1])
      if (found.error) return json(response, found.error[0], { error: found.error[1] })
      const { record } = found
      if (record.size > config.maxBytes) {
        return json(response, 413, {
          error: `Session is ${Math.round(record.size / 1024 / 1024)}MB, over the ${Math.round(config.maxBytes / 1024 / 1024)}MB limit`,
        })
      }

      const hints = await peek(record.path)
      const transformer = createTransformer({
        sessionId: record.id,
        project: hints.cwd,
        timestamp: hints.timestamp ?? new Date(record.mtime).toISOString(),
      })
      const gzip = /\bgzip\b/.test(request.headers['accept-encoding'] ?? '')
      const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Session-Format': hints.format,
        ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
      }
      response.writeHead(200, headers)

      const target = gzip ? createGzip() : response
      if (gzip) target.pipe(response)

      const lines = createInterface({
        input: createReadStream(record.path, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      })
      try {
        for await (const line of lines) {
          const chunk = transformer.transform(line)
          if (chunk.length === 0) continue
          if (!target.write(`${chunk.join('\n')}\n`)) {
            await new Promise((resolve) => target.once('drain', resolve))
          }
        }
        target.end()
      } catch (error) {
        target.destroy(error)
        if (!response.headersSent) json(response, 500, { error: 'Read failed' })
      }
      return undefined
    }

    const metaMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (metaMatch) {
      const found = await findSession(metaMatch[1])
      if (found.error) return json(response, found.error[0], { error: found.error[1] })
      const { record } = found
      const hints = await peek(record.path)
      return json(response, 200, {
        id: record.id,
        project: hints.cwd,
        projectDir: record.projectDir,
        size: record.size,
        mtime: record.mtime,
        format: hints.format,
        candidates: record.candidates,
        tooLarge: record.size > config.maxBytes,
      })
    }

    if (pathname.startsWith('/api/')) return json(response, 404, { error: 'Not found' })

    if (await serveStatic(request, response, pathname)) return undefined
    return text(response, 404, 'Not found')
  }
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === import.meta.filename : false

if (isMain) {
  const config = loadConfig()
  const app = createApp(config)
  const server = createServer((request, response) => {
    app(request, response).catch((error) => {
      if (!response.headersSent) json(response, 500, { error: 'Internal error' })
      console.error(error)
    })
  })
  server.listen(config.port, config.host, () => {
    console.log(`session viewer on http://${config.host}:${config.port}`)
    console.log(`roots: ${config.roots.join(', ')}`)
    console.log(`static: ${config.staticDir}`)
  })
}
