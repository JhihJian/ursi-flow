// @vitest-environment node
import { createServer, request, type IncomingMessage, type RequestOptions } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preview } from 'vite'
import { expect, it } from 'vitest'
import { lanPreviewProxy } from './lan-preview-proxy'
import { lanPreviewHeader } from '../shared/http/lan-preview'

const origin = 'http://192.168.1.135:4281'
const host = new URL(origin).host
const api = '/api/v2/work-projects'
const sampleId = '00000000-0000-0000-0000-000000000001'

it('免登录代理限制来源、主机、浏览器同源和规划 API，再为回环请求补充令牌', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ursi-lan-test-'))
  const tokenPath = join(root, 'access-token')
  const received: IncomingMessage[] = []
  const backend = createServer((req, res) => { received.push(req); res.end('[]') }).listen(0, '127.0.0.1')
  try {
    await once(backend, 'listening')
    const backendPort = (backend.address() as { port: number }).port
    const target = `http://127.0.0.1:${backendPort}`
    await mkdir(join(root, 'dist-lan'))
    await writeFile(join(root, 'dist-lan/index.html'), '<!doctype html><title>preview</title>')
    await writeFile(tokenPath, 'upstream-only-test-token', { mode: 0o600 })
    async function serve(cidr: string) {
      const gateway = lanPreviewProxy(target, {
        URSI_LAN_PREVIEW_CIDR: cidr, URSI_LAN_PREVIEW_ORIGIN: origin, URSI_LAN_PREVIEW_TOKEN_FILE: tokenPath,
      })
      return preview({ root, configFile: false, build: { outDir: 'dist-lan' }, plugins: [gateway.plugin],
        preview: { host: '127.0.0.1', port: 0, cors: false, proxy: gateway.proxy } })
    }
    function call(port: number, path: string, options: RequestOptions = {}) {
      return new Promise<number | undefined>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path, ...options,
          headers: { host, [lanPreviewHeader]: '1', ...options.headers } }, res => {
          res.resume()
          res.once('end', () => resolve(res.statusCode))
        })
        req.once('error', reject)
        req.end()
      })
    }
    const server = await serve('127.0.0.1/32')
    try {
      const port = (server.httpServer.address() as { port: number }).port
      expect(await call(port, '/work-projects')).toBe(200)
      expect(await call(port, api, { headers: { host: 'other.local' } })).toBe(403)
      expect(await call(port, api, { headers: { [lanPreviewHeader]: '' } })).toBe(403)
      expect(await call(port, api, { headers: { origin: 'http://other.local' } })).toBe(403)
      expect(await call(port, api, { method: 'POST' })).toBe(403)
      expect(await call(port, api, { method: 'OPTIONS' })).toBe(404)
      expect(await call(port, '/api/v2/platform-env')).toBe(404)
      expect(await call(port, '/api/v1/flows')).toBe(404)
      expect(await call(port, `${api}/${sampleId}/commands`, { method: 'PUT', headers: { origin } })).toBe(404)
      expect(received).toHaveLength(0)
      expect(await call(port, `${api}/${sampleId}/workspace?view=map`)).toBe(200)
      expect(await call(port, '/api/v2/work-items', { method: 'POST', headers: { origin, authorization: 'Bearer browser-token' } })).toBe(200)
      expect(received.map(req => [req.method, req.url, req.headers.authorization, req.headers[lanPreviewHeader]])).toEqual([
        ['GET', `${api}/${sampleId}/workspace?view=map`, 'Bearer upstream-only-test-token', undefined],
        ['POST', '/api/v2/work-items', 'Bearer upstream-only-test-token', undefined],
      ])
    } finally { await server.close() }
    const otherNetwork = await serve('192.168.1.0/24')
    try {
      const port = (otherNetwork.httpServer.address() as { port: number }).port
      const headers = { 'x-forwarded-for': '192.168.1.63' }
      expect(await call(port, '/work-items', { headers })).toBe(403)
      expect(await call(port, api, { headers })).toBe(403)
      expect(received).toHaveLength(2)
    } finally { await otherNetwork.close() }
  } finally {
    await new Promise<void>(resolve => backend.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
