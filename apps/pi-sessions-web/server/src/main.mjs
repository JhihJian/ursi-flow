import { createReadStream, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { createGzip } from 'node:zlib'
import { createAccess } from './access.mjs'
import { createTransformer } from './canonicalize.mjs'
import { loadConfig } from './config.mjs'
import { deleteSessionFile } from './delete.mjs'
import { createPrefs } from './prefs.mjs'
import { createScanner } from './scan.mjs'

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

const text = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end(body)
}

const PERSIST_DELAY_MS = 5000
/** 请求体上限：只有偏好这种小对象走 POST，1KB 足够塞下上百个项目键。 */
const MAX_BODY_BYTES = 64 * 1024

/** 读取并解析 JSON 请求体；超过上限或不是合法 JSON 都返回 null。 */
async function readJsonBody(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      request.destroy()
      return null
    }
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 索引落盘：先写临时文件再改名，半个文件不会被下次启动读到。 */
function createPersister({ stateFile, scanner }) {
  let timer = null
  const write = () => {
    timer = null
    const temporary = `${stateFile}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, entries: scanner.toJSON() }), { mode: 0o600 })
      renameSync(temporary, stateFile)
    } catch {
      // 落盘只是加速：写不进去下次重启照样能扫出来
    }
  }
  return {
    /** 合并短时间内的多次变更，一次写盘。 */
    schedule() {
      if (timer) return
      timer = setTimeout(write, PERSIST_DELAY_MS)
      timer.unref?.()
    },
    async load() {
      try {
        const parsed = JSON.parse(await readFile(stateFile, 'utf8'))
        if (parsed?.version === 1) scanner.load(parsed.entries)
      } catch {
        // 没有索引或索引损坏都从空开始
      }
    },
    flush() {
      if (!timer) return
      clearTimeout(timer)
      write()
    },
  }
}

/**
 * 只读服务：列任意根目录下的会话、给单个会话的元信息与文本。
 * 解析与渲染都在浏览器里由组件库完成，这里不做分页。
 */
export async function createApp(config = loadConfig()) {
  await mkdir(dirname(config.stateFile), { recursive: true }).catch(() => undefined)
  const scanner = createScanner()
  const persister = createPersister({ stateFile: config.stateFile, scanner })
  await persister.load()
  scanner.onPersist(() => persister.schedule())

  const prefs = createPrefs({ file: config.prefsFile })
  await prefs.load()

  const access = createAccess()

  /** 写操作统一在这里拦一道，局域网访问拿到 403 而不是静默失败。 */
  const refuseWrite = (request, response) => {
    if (access.canWrite(request)) return false
    json(response, 403, { error: '删除与偏好只能在服务所在机器上操作（局域网访问为只读）' })
    return true
  }

  /**
   * 根路径由浏览器给出，这里只做三件事：展开 `~`、要求绝对路径、要求是目录。
   * 指向哪里由用户决定，服务默认只听回环地址。
   */
  const resolveRoot = async (input) => {
    const raw = typeof input === 'string' ? input.trim() : ''
    if (!raw) return { error: [400, '缺少 root 参数'] }
    const expanded = raw === '~' || raw.startsWith('~/') ? resolve(process.env.HOME ?? '~', raw.slice(2)) : raw
    if (!isAbsolute(expanded)) return { error: [400, `root 必须是绝对路径：${raw}`] }
    const path = resolve(expanded)
    const info = await stat(path).catch(() => null)
    if (!info) return { error: [400, `目录不存在：${path}`] }
    if (!info.isDirectory()) return { error: [400, `不是目录：${path}`] }
    return { path }
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
        response.writeHead(200, {
          'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
          'Content-Length': info.size,
          'Cache-Control': extname(file) === '.html' ? 'no-store' : 'public, max-age=3600',
        })
        createReadStream(file).pipe(response)
        return true
      } catch {
        continue
      }
    }
    return false
  }

  /** 单个会话的文本：逐行转换成组件库认的形状后流式输出，可 gzip。 */
  const sendText = async (request, response, record) => {
    if (record.size > config.maxTextBytes) {
      return json(response, 413, {
        error: `会话 ${Math.round(record.size / 1024 / 1024)}MB，超过 ${Math.round(config.maxTextBytes / 1024 / 1024)}MB 上限`,
      })
    }
    const transformer = createTransformer({
      sessionId: record.id,
      project: record.cwd || null,
      timestamp: Number.isFinite(record.created) ? new Date(record.created).toISOString() : new Date().toISOString(),
    })
    const gzip = /\bgzip\b/.test(request.headers['accept-encoding'] ?? '')
    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Session-Format': record.format,
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    })
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
          await new Promise((done) => target.once('drain', done))
        }
      }
      target.end()
    } catch (error) {
      target.destroy(error)
      if (!response.headersSent) json(response, 500, { error: '读取失败' })
    }
    return undefined
  }

  return {
    scanner,
    persister,
    prefs,
    async handle(request, response) {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`)
      const { pathname } = url

      if (pathname === '/api/health') return text(response, 200, 'ok')

      if (pathname === '/api/config') {
        return json(response, 200, {
          defaultRoot: config.defaultRoot,
          suggestedRoots: config.suggestedRoots,
          maxTextBytes: config.maxTextBytes,
          /** 当前来源能否删除会话、改偏好；界面据此禁用菜单项并给出原因。 */
          canWrite: access.canWrite(request),
        })
      }

      if (pathname === '/api/prefs') {
        if (request.method === 'PUT') {
          if (refuseWrite(request, response)) return undefined
          const body = await readJsonBody(request)
          if (!body) return json(response, 400, { error: '请求体必须是 JSON 对象' })
          const pin = body.pin === undefined ? undefined : body.pin
          const unpin = body.unpin === undefined ? undefined : body.unpin
          if (pin === undefined && unpin === undefined) {
            return json(response, 400, { error: '需要 pin 或 unpin' })
          }
          if (pin !== undefined && typeof pin !== 'string') {
            return json(response, 400, { error: 'pin 必须是 projectKey 字符串' })
          }
          if (unpin !== undefined && typeof unpin !== 'string') {
            return json(response, 400, { error: 'unpin 必须是 projectKey 字符串' })
          }
          const result = await prefs.apply({ pin, unpin })
          return json(response, 200, { pinnedProjects: result.pinnedProjects })
        }
        return json(response, 200, prefs.get())
      }

      if (pathname === '/api/browse') {
        const root = await resolveRoot(url.searchParams.get('path') ?? config.defaultRoot)
        if (root.error) return json(response, root.error[0], { error: root.error[1] })
        const listing = await scanner.browse(root.path)
        if (!listing) return json(response, 400, { error: `无法读取目录：${root.path}` })
        return json(response, 200, listing)
      }

      if (pathname === '/api/sessions') {
        const root = await resolveRoot(url.searchParams.get('root'))
        if (root.error) return json(response, root.error[0], { error: root.error[1] })
        const listing = await scanner.list(root.path)
        return json(response, 200, listing)
      }

      const textMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/text$/)
      if (textMatch) {
        const root = await resolveRoot(url.searchParams.get('root'))
        if (root.error) return json(response, root.error[0], { error: root.error[1] })
        const record = await scanner.find(root.path, decodeURIComponent(textMatch[1]))
        if (!record) return json(response, 404, { error: '会话不存在' })
        return sendText(request, response, record)
      }

      const metaMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (metaMatch && request.method === 'DELETE') {
        if (refuseWrite(request, response)) return undefined
        const root = await resolveRoot(url.searchParams.get('root'))
        if (root.error) return json(response, root.error[0], { error: root.error[1] })
        const record = await scanner.find(root.path, decodeURIComponent(metaMatch[1]))
        if (!record) return json(response, 404, { error: '会话不存在' })
        const result = await deleteSessionFile({ path: record.path, root: root.path })
        if (result.error) return json(response, result.error[0], { error: result.error[1] })
        scanner.forget(record.path)
        persister.schedule()
        return json(response, 200, { id: record.id, removed: result.removed })
      }

      if (metaMatch) {
        const root = await resolveRoot(url.searchParams.get('root'))
        if (root.error) return json(response, root.error[0], { error: root.error[1] })
        const record = await scanner.find(root.path, decodeURIComponent(metaMatch[1]))
        if (!record) return json(response, 404, { error: '会话不存在' })
        return json(response, 200, { ...record, tooLarge: record.size > config.maxTextBytes })
      }

      if (pathname.startsWith('/api/')) return json(response, 404, { error: '未知接口' })

      if (await serveStatic(request, response, pathname)) return undefined
      return text(response, 404, 'Not found')
    },
  }
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === import.meta.filename : false

if (isMain) {
  const config = loadConfig()
  const app = await createApp(config)
  const server = createServer((request, response) => {
    app.handle(request, response).catch((error) => {
      if (!response.headersSent) json(response, 500, { error: '内部错误' })
      console.error(error)
    })
  })
  server.listen(config.port, config.host, () => {
    console.log(`pi-sessions-web on http://${config.host}:${config.port}`)
    console.log(`default root: ${config.defaultRoot}`)
    console.log(`static: ${config.staticDir}`)
  })
  const shutdown = () => {
    app.persister.flush()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
