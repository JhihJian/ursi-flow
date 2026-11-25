import { createReadStream, promises as fs } from 'node:fs'
import type http from 'node:http'
import path from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/** 静态产物：命中目录或缺失时回退 index.html，缺资源按 404 处理。 */
export function createStaticHandler(staticDir: string) {
  return async function serveStatic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      res.writeHead(400).end('bad request')
      return
    }

    const target = path.resolve(staticDir, `.${pathname}`)
    if (target !== staticDir && !target.startsWith(`${staticDir}${path.sep}`)) {
      res.writeHead(403).end('forbidden')
      return
    }

    let file = target
    try {
      const info = await fs.stat(file)
      if (info.isDirectory()) file = path.join(file, 'index.html')
    } catch {
      file = path.join(staticDir, 'index.html')
    }

    const ext = path.extname(file)
    try {
      const info = await fs.stat(file)
      if (!info.isFile()) throw new Error('not a file')
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': file.includes(`${path.sep}assets${path.sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      })
      createReadStream(file).pipe(res)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found')
    }
  }
}
