import type { Collection, Definition, Executor, Ref, Resource } from './catalog'

/**
 * 按 server/src/work/catalog 的读写契约实现的测试替身：
 * 修订号从 1 递增、历史按版本冻结、发布时校验固定引用和停用状态、MCP 不能绑定为执行依赖。
 */
type Body = Record<string, unknown>
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function createFakeCatalog() {
  const store: Record<Collection, Definition[]> = { resources: [], executors: [] }
  const disabled = new Set<string>()
  const received: { method: string; path: string; body?: Body }[] = []
  const pendingFailures: string[] = []
  const off = (k: Collection, id: string) => disabled.has(`${k}/${id}`)
  const versions = (k: Collection, id: string) => store[k].filter(v => v.id === id)
  const latest = (k: Collection, id: string) => versions(k, id).at(-1)

  function find<T extends Definition>(k: Collection, ref: Ref): T {
    const list = versions(k, ref.id)
    if (!list.length) throw new Error(`引用了不存在的 ${k} ${ref.id}`)
    if (off(k, ref.id)) throw new Error(`${k} ${ref.id} 已停用`)
    const found = list.find(v => v.revision === ref.revision)
    if (!found) throw new Error(`${k} ${ref.id} 缺少 v${ref.revision}`)
    return found as T
  }
  function pin(k: Collection, value: unknown, field: string): Ref {
    const ref = value as { id?: unknown; revision?: unknown } | null
    if (!ref || typeof ref.id !== 'string' || !ref.id || !Number.isSafeInteger(ref.revision)) throw new Error(`${field} 必须使用 {id, revision} 固定版本`)
    find(k, { id: ref.id, revision: ref.revision as number })
    return { id: ref.id, revision: ref.revision as number }
  }
  function pins(k: Collection, value: unknown, field: string): Ref[] {
    if (value === undefined) return []
    if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`)
    return value.map(item => pin(k, item, field))
  }
  function bindable(value: unknown, field: string): Ref[] {
    return pins('resources', value, field).map(ref => {
      const resource = find<Resource>('resources', ref)
      if (resource.kind === 'mcp') throw new Error(`${field} 不能绑定 MCP 引用 ${ref.id} v${ref.revision}`)
      return ref
    })
  }
  function text(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空`)
    return value
  }

  function resource(id: string, body: Body): Resource {
    const kind = body.kind
    if (kind !== 'skill' && kind !== 'prompt' && kind !== 'mcp') throw new Error('资源类型无效')
    if (kind === 'mcp') {
      const content = body.content as { serverRef?: unknown; credentialRef?: unknown } | undefined
      const serverRef = text(content?.serverRef, 'MCP 服务引用')
      const credentialRef = typeof content?.credentialRef === 'string' && content.credentialRef ? content.credentialRef : undefined
      return { id, revision: 0, kind, content: credentialRef ? { serverRef, credentialRef } : { serverRef } }
    }
    return { id, revision: 0, kind, content: text(body.content, '资源内容') }
  }
  function executor(id: string, body: Body): Executor {
    const schema = body.configSchema
    if (schema !== undefined && (!schema || typeof schema !== 'object')) throw new Error('configSchema 必须是对象或数组')
    return { id, revision: 0, resources: bindable(body.resources, '执行器资源'),
      ...(schema !== undefined ? { configSchema: schema as Executor['configSchema'] } : {}) }
  }
  function publish(k: Collection, body: Body) {
    const failure = pendingFailures.shift()
    if (failure) throw new Error(failure)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) throw new Error('缺少定义 ID')
    if (off(k, id)) throw new Error(`${id} 已停用，不能发布新版`)
    const value = k === 'resources' ? resource(id, body) : executor(id, body)
    const revision = versions(k, id).length + 1
    const stored = { ...value, revision } as Definition
    store[k].push(stored)
    return clone(stored)
  }

  function handle(path: string, options: RequestInit = {}) {
    const method = (options.method ?? 'GET').toUpperCase()
    const body = options.body ? JSON.parse(String(options.body)) as Body : undefined
    received.push({ method, path, body })
    const [head, ...rest] = path.split('/').filter(Boolean)
    const k = head as Collection
    if (!['resources', 'executors'].includes(k)) return Response.json({ error: '未知目录' }, { status: 404 })
    try {
      if (method === 'POST' && rest.length === 0) return Response.json(publish(k, body ?? {}))
      if (method === 'POST' && rest.length === 2 && rest[1] === 'deactivate') {
        disabled.add(`${k}/${decodeURIComponent(rest[0])}`)
        return Response.json({ ...latest(k, decodeURIComponent(rest[0])), active: false })
      }
      if (method !== 'GET') return Response.json({ error: '不支持的方法' }, { status: 405 })
      if (rest.length === 0) return Response.json(store[k].filter(v => latest(k, v.id) === v).map(v => ({ ...clone(v), active: !off(k, v.id) })))
      const id = decodeURIComponent(rest[0])
      const list = versions(k, id)
      if (!list.length) return Response.json({ error: `${k} ${id} 不存在` }, { status: 404 })
      if (rest.length === 1) return Response.json({ ...clone(list.at(-1)!), active: !off(k, id) })
      if (rest[1] !== 'revisions') return Response.json({ error: '未知路径' }, { status: 404 })
      if (rest.length === 2) return Response.json(clone(list))
      const found = list.find(v => v.revision === Number(rest[2]))
      return found ? Response.json(clone(found)) : Response.json({ error: `${id} 缺少 v${rest[2]}` }, { status: 404 })
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : '发布失败' }, { status: 400 })
    }
  }

  return {
    handle,
    received,
    seed: (k: Collection, body: Body) => publish(k, body),
    failNext: (message: string) => { pendingFailures.push(message) },
    deactivate: (k: Collection, id: string) => { disabled.add(`${k}/${id}`) },
    versions: (k: Collection, id: string) => clone(versions(k, id)),
    latest: <T extends Definition>(k: Collection, id: string) => clone(latest(k, id) as T),
    posts: (k: Collection) => received.filter(r => r.method === 'POST' && r.path === `/${k}`).map(r => r.body),
  }
}
