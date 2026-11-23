import { readFileSync, realpathSync, statSync } from 'node:fs'
import { BlockList, isIPv4 } from 'node:net'
import { join, relative, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'
import { lanPreviewHeader } from '../shared/http/lan-preview'

const api = '^/api/v2/(?:work-items|work-projects)(?=/|\\?|$)'
const uuid = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}'
const collection = /^\/api\/v2\/(?:work-items|work-projects)$/
const item = new RegExp(`^/api/v2/work-items/${uuid}(?:/(placement))?$`)
const project = new RegExp(`^/api/v2/work-projects/${uuid}(?:/(workspace|commands|layout))?$`)

function allowsApi(method: string, path: string) {
  if (collection.test(path)) return ['GET', 'POST'].includes(method)
  const itemMatch = item.exec(path)
  if (itemMatch) return itemMatch[1] ? method === 'GET' : ['GET', 'PUT', 'DELETE'].includes(method)
  switch (project.exec(path)?.[1]) {
    case 'workspace': return method === 'GET'
    case 'commands': return method === 'POST'
    case 'layout': return method === 'PUT'
    default: return project.test(path) && ['PUT', 'DELETE'].includes(method)
  }
}

export function lanPreviewProxy(target: string, env: Record<string, string>) {
  const upstream = new URL(target)
  if (upstream.origin !== target || upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || !upstream.port) {
    throw new Error('免登录预览的 URSI_API_PROXY 必须是带端口的 IPv4 回环 HTTP origin。')
  }
  const configuredOrigin = env.URSI_LAN_PREVIEW_ORIGIN
  const origin = new URL(configuredOrigin ?? '')
  if (origin.origin !== configuredOrigin || origin.protocol !== 'http:' || !isIPv4(origin.hostname)) {
    throw new Error('URSI_LAN_PREVIEW_ORIGIN 必须是预览的 IPv4 HTTP origin。')
  }
  const [network, length, extra] = (env.URSI_LAN_PREVIEW_CIDR ?? '').split('/')
  const prefix = Number(length)
  if (!isIPv4(network) || !Number.isInteger(prefix) || prefix < 1 || prefix > 32 || extra !== undefined) {
    throw new Error('URSI_LAN_PREVIEW_CIDR 必须指定受信的 IPv4 网段。')
  }
  const peers = new BlockList()
  peers.addSubnet(network, prefix)
  const plugin: Plugin = {
    name: 'ursi-lan-preview',
    configurePreviewServer(server) {
      const dist = realpathSync(resolve(server.config.root, server.config.build.outDir))
      if (!statSync(join(dist, 'index.html')).isFile()) throw new Error('请先构建免登录预览。')
      const tokenPath = realpathSync(env.URSI_LAN_PREVIEW_TOKEN_FILE ?? '')
      const fromDist = relative(dist, tokenPath)
      if (fromDist !== '..' && !fromDist.startsWith(`..${sep}`)) throw new Error('访问令牌必须保存在静态目录外。')
      const details = statSync(tokenPath)
      if (!details.isFile() || (details.mode & 0o077) !== 0) throw new Error('访问令牌文件必须仅对服务账户可读。')
      const token = readFileSync(tokenPath, 'utf8').trim()
      if (!/^[\x21-\x7e]+$/.test(token)) throw new Error('访问令牌文件内容无效。')
      server.middlewares.use((req, res, next) => {
        const peer = req.socket.remoteAddress?.replace(/^::ffff:/i, '') ?? ''
        const deny = (status: number) => {
          res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({ error: status === 404 ? '此接口不在预览范围内。' : '此请求不在预览访问范围内。' }))
        }
        if (!isIPv4(peer) || !peers.check(peer) || req.headers.host !== origin.host) return deny(403)
        const path = (req.url ?? '').split('?', 1)[0] ?? ''
        if (!path.startsWith('/api/')) return next()
        const method = req.method ?? ''
        if (!allowsApi(method, path)) return deny(404)
        const requestOrigin = req.headers.origin
        if (req.headers[lanPreviewHeader] !== '1' || (requestOrigin !== origin.origin && (method !== 'GET' || requestOrigin !== undefined))) return deny(403)
        delete req.headers[lanPreviewHeader]
        req.headers.authorization = `Bearer ${token}`
        next()
      })
    },
  }
  return { plugin, proxy: { [api]: { target } } }
}
