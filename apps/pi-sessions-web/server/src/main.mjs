import { createReadStream, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { createGzip } from 'node:zlib'
import { createTransformer } from './canonicalize.mjs'
import { loadConfig } from './config.mjs'
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
    async handle(request, response) {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`)
      const { pathname } = url

      if (pathname === '/api/health') return text(response, 200, 'ok')

      if (pathname === '/api/config') {
        return json(response, 200, {
          defaultRoot: config.defaultRoot,
          suggestedRoots: config.suggestedRoots,
          maxTextBytes: config.maxTextBytes,
        })
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
