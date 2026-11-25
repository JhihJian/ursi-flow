import type http from 'node:http'
import { sendError, sendJson, readBody } from './http-util.ts'
import { resolveRequestedHome, defaultHomeIfValid, HomeError, looksLikePiHome } from './pi-home.ts'
import { HomeRegistry } from './homes.ts'
import { readSettings, mutateSettings } from './settings-file.ts'
import { ConflictError } from './rw.ts'
import { listSkills, readDisableModelInvocation, toggleDisableModelInvocation } from './skills.ts'
import { listAgentProfiles, saveAgentProfile, deleteAgentProfile, readAgentsSettings, writeAgentsSettings, renderProfile } from './agents.ts'
import { readMcp, mergeMcp } from './mcp-file.ts'
import { readModels, mergeModels, readAuth, mergeAuth } from './models-auth.ts'
import { listPackages, applyPackagesMutation } from './plugins.ts'
import { createStaticHandler } from './static.ts'
import { isLoopback } from './http-util.ts'

/**
 * pi-manager-web API：每个请求的 home 都来自 ?home= 参数，服务端无全局状态。
 * 读接口任意来源可访问（凭据字段已遮蔽）；写接口只允许回环来源。
 */

const BODY_LIMIT = 512 * 1024

interface RouteContext {
  home: string
  url: URL
  req: http.IncomingMessage
  body: <T>() => Promise<T>
}

type Handler = (ctx: RouteContext) => Promise<unknown>

const ROUTES: Array<{ method: string; prefix: string; handler: Handler }> = []

function route(method: string, prefix: string, handler: Handler): void {
  ROUTES.push({ method, prefix, handler })
}

// ---------------------------------------------------------------------------
// home
// ---------------------------------------------------------------------------

route('GET', '/api/home/defaults', async () => ({
  default: defaultHomeIfValid(),
}))

route('GET', '/api/home/check', async ({ url }) => {
  const raw = url.searchParams.get('home')
  const real = await resolveRequestedHome(raw)
  return { home: real, valid: looksLikePiHome(real) }
})

// pi home 清单：注册表条目 + 自动发现（默认位置、env、同机其他用户）。
// 注册表由服务端持有并落盘，条目可改名、编辑说明、移除；也可创建新 home。
const homes = new HomeRegistry()

route('GET', '/api/homes', async () => ({ homes: homes.list() }))

route('POST', '/api/homes', async ({ body }) => {
  const payload = await body<{
    mode?: unknown
    path?: unknown
    name?: unknown
    from?: unknown
    includeAuth?: unknown
  }>()
  const mode = payload.mode
  if (mode !== 'adopt' && mode !== 'init' && mode !== 'clone') {
    throw new HomeError('mode 必须是 adopt / init / clone', 400, 'invalid_request')
  }
  if (typeof payload.path !== 'string') {
    throw new HomeError('path 必填', 400, 'invalid_request')
  }
  const home = await homes.add({
    mode,
    path: payload.path,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    from: typeof payload.from === 'string' ? payload.from : undefined,
    includeAuth: payload.includeAuth === true,
  })
  return { home }
})

route('PATCH', '/api/homes', async ({ body }) => {
  const payload = await body<{ id?: unknown; name?: unknown; description?: unknown }>()
  if (typeof payload.id !== 'string' || !payload.id) {
    throw new HomeError('id 必填', 400, 'invalid_request')
  }
  const home = await homes.update(payload.id, {
    name: typeof payload.name === 'string' ? payload.name : undefined,
    description: typeof payload.description === 'string' ? payload.description : undefined,
  })
  return { home }
})

route('DELETE', '/api/homes', async ({ body }) => {
  const payload = await body<{ id?: unknown }>()
  if (typeof payload.id !== 'string' || !payload.id) {
    throw new HomeError('id 必填', 400, 'invalid_request')
  }
  await homes.remove(payload.id)
  return { ok: true }
})

// ---------------------------------------------------------------------------
// general：settings.json 的受管 key
// ---------------------------------------------------------------------------

const MANAGED_KEYS = ['defaultModel', 'defaultThinkingLevel', 'defaultTools', 'codemode', 'packages', 'showCacheMissNotices'] as const

route('GET', '/api/general', async ({ home }) => {
  const snap = readSettings(home)
  const managed: Record<string, unknown> = {}
  for (const key of MANAGED_KEYS) {
    if (snap.data[key] !== undefined) managed[key] = snap.data[key]
  }
  return {
    revision: snap.revision,
    path: snap.path,
    managed,
    keyCount: Object.keys(snap.data).length,
    unmanagedKeys: Object.keys(snap.data).filter((k) => !(MANAGED_KEYS as readonly string[]).includes(k)),
  }
})

route('PUT', '/api/general/key', async ({ home, req, body }) => {
  const payload = await body<{ key?: string; value?: unknown; revision?: string }>()
  if (typeof payload.key !== 'string' || !(MANAGED_KEYS as readonly string[]).includes(payload.key)) {
    throw new HomeError(`只允许写受管 key：${MANAGED_KEYS.join(', ')}`, 400, 'unmanaged_key')
  }
  if (typeof payload.revision !== 'string') throw new HomeError('缺少 revision', 400, 'missing_revision')
  const result = mutateSettings(home, payload.revision, (settings) => {
    if (JSON.stringify(settings[payload.key!]) === JSON.stringify(payload.value)) return false
    if (payload.value === null) delete settings[payload.key!]
    else settings[payload.key!] = payload.value
    return true
  })
  return { ok: true, ...result }
})

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

route('GET', '/api/skills', async ({ home }) => listSkills(home))

route('POST', '/api/skills/toggle', async ({ home, body }) => {
  const payload = await body<{ relDir?: string; disabled?: boolean }>()
  if (typeof payload.relDir !== 'string' || typeof payload.disabled !== 'boolean') {
    throw new HomeError('relDir 与 disabled 必填', 400, 'invalid_request')
  }
  const { readFile, writeFile, rename, copyFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const path = join(home, 'skills', payload.relDir, 'SKILL.md')
  if (!path.startsWith(join(home, 'skills') + '/')) throw new HomeError('relDir 越界', 400, 'invalid_request')
  const text = await readFile(path, 'utf8')
  const next = toggleDisableModelInvocation(text, payload.disabled)
  if (next !== text) {
    await copyFile(path, `${path}.bak-manager`)
    const tmp = `${path}.tmp-manager`
    await writeFile(tmp, next, { mode: 0o600 })
    await rename(tmp, path)
  }
  return { ok: true, disabled: readDisableModelInvocation(path) }
})

// ---------------------------------------------------------------------------
// agents（subagent profiles）
// ---------------------------------------------------------------------------

route('GET', '/api/agents', async ({ home }) => ({
  profiles: listAgentProfiles(home),
  settings: readAgentsSettings(home),
}))

route('GET', '/api/agents/profile', async ({ home, url }) => {
  const file = url.searchParams.get('file') ?? ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/.test(file)) throw new HomeError('非法文件名', 400, 'invalid_file')
  const { join } = await import('node:path')
  const { readFileSync, statSync } = await import('node:fs')
  const path = join(home, 'agents', file)
  const text = readFileSync(path, 'utf8')
  const info = statSync(path)
  return {
    file,
    content: text,
    revision: `${Math.round(info.mtimeMs)}.${info.size}`,
  }
})

route('PUT', '/api/agents/profile', async ({ home, body }) => {
  const payload = await body<{
    file?: string
    name?: string
    description?: string
    extraKeys?: string[]
    body?: string
    revision?: string
  }>()
  if (typeof payload.file !== 'string' || typeof payload.name !== 'string' || !payload.name.trim()) {
    throw new HomeError('file 与 name 必填', 400, 'invalid_request')
  }
  if (!payload.file.endsWith('.md')) payload.file = `${payload.file}.md`
  const content = renderProfile({
    name: payload.name.trim(),
    description: typeof payload.description === 'string' ? payload.description : '',
    extraKeys: Array.isArray(payload.extraKeys) ? payload.extraKeys.filter((l): l is string => typeof l === 'string') : [],
    body: typeof payload.body === 'string' ? payload.body : '',
  })
  const revision = await saveAgentProfile(home, payload.file, payload.revision, content)
  return { ok: true, file: payload.file, revision }
})

route('DELETE', '/api/agents/profile', async ({ home, body }) => {
  const payload = await body<{ file?: string }>()
  if (typeof payload.file !== 'string') throw new HomeError('file 必填', 400, 'invalid_request')
  await deleteAgentProfile(home, payload.file)
  return { ok: true }
})

route('PUT', '/api/agents/settings', async ({ home, body }) => {
  const payload = await body<{
    builtInEnabled?: boolean
    disabledBuiltIns?: string[]
    maxConcurrent?: number
    revision?: string
  }>()
  const current = readAgentsSettings(home)
  if (typeof payload.revision !== 'string') throw new HomeError('缺少 revision', 400, 'missing_revision')
  if (current.exists && current.revision !== payload.revision) {
    throw new ConflictError('agents/settings.json 已被其他进程修改')
  }
  const disabled = Array.isArray(payload.disabledBuiltIns)
    ? payload.disabledBuiltIns.filter((v): v is string => typeof v === 'string')
    : current.disabledBuiltIns
  const revision = await writeAgentsSettings(home, payload.revision, {
    builtInEnabled: typeof payload.builtInEnabled === 'boolean' ? payload.builtInEnabled : current.builtInEnabled,
    disabledBuiltIns: disabled,
    maxConcurrent: typeof payload.maxConcurrent === 'number' && payload.maxConcurrent > 0 ? Math.floor(payload.maxConcurrent) : current.maxConcurrent,
  })
  return { ok: true, revision, settings: readAgentsSettings(home) }
})

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

route('GET', '/api/mcp', async ({ home }) => readMcp(home))

route('PUT', '/api/mcp/servers', async ({ home, body }) => {
  const payload = await body<{ servers?: Record<string, Record<string, unknown> | null>; revision?: string }>()
  if (typeof payload.revision !== 'string') throw new HomeError('缺少 revision', 400, 'missing_revision')
  const revision = await mergeMcp(home, payload.revision, payload.servers ?? {})
  return { ok: true, revision }
})

// ---------------------------------------------------------------------------
// models + auth
// ---------------------------------------------------------------------------

route('GET', '/api/models', async ({ home }) => readModels(home))

route('PUT', '/api/models/providers', async ({ home, body }) => {
  const payload = await body<{ providers?: Record<string, Record<string, unknown> | null>; revision?: string }>()
  if (typeof payload.revision !== 'string') throw new HomeError('缺少 revision', 400, 'missing_revision')
  const revision = await mergeModels(home, payload.revision, payload.providers ?? {})
  return { ok: true, revision }
})

route('GET', '/api/auth', async ({ home }) => readAuth(home))

// 合并写回：只改提交里出现的 provider，null 删除条目，掩码占位符按原文还原。
route('PUT', '/api/auth/entries', async ({ home, body }) => {
  const payload = await body<{ revision?: string; entries?: Record<string, unknown> }>()
  if (!payload.entries || typeof payload.entries !== 'object' || Array.isArray(payload.entries)) {
    throw new HomeError('entries 必须是对象', 400, 'invalid_request')
  }
  const entries: Record<string, Record<string, unknown> | null> = {}
  for (const [provider, value] of Object.entries(payload.entries)) {
    if (value === null) {
      entries[provider] = null
      continue
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new HomeError(`provider ${provider} 的条目必须是对象或 null`, 400, 'invalid_request')
    }
    entries[provider] = value as Record<string, unknown>
  }
  const revision = await mergeAuth(home, payload.revision ?? '', entries)
  return { ok: true, revision }
})

// ---------------------------------------------------------------------------
// plugins（settings.json 的 packages 条目）
// ---------------------------------------------------------------------------

route('GET', '/api/plugins', async ({ home }) => {
  const snap = readSettings(home)
  return {
    packages: listPackages(home),
    revision: snap.revision,
  }
})

route('POST', '/api/plugins/entry', async ({ home, body }) => {
  const payload = await body<{ action?: 'enable' | 'disable' | 'remove'; index?: number; revision?: string }>()
  if (typeof payload.index !== 'number' || typeof payload.revision !== 'string' || !payload.action) {
    throw new HomeError('action、index 与 revision 必填', 400, 'invalid_request')
  }
  const mutation = applyPackagesMutation(home, payload.action, payload.index)
  if (mutation.refusals.length > 0) {
    throw new HomeError(mutation.refusals.join('；'), 409, 'mutation_refused')
  }
  const result = mutateSettings(home, payload.revision, (settings) => {
    if (JSON.stringify(settings.packages) === JSON.stringify(mutation.packages)) return false
    if (mutation.packages.length === 0) delete settings.packages
    else settings.packages = mutation.packages
    return true
  })
  return { ok: true, ...result }
})

// ---------------------------------------------------------------------------

export function createApiHandler(): (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => Promise<boolean> {
  return async (req, res, pathname) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!pathname.startsWith('/api/')) return false

    try {
      const match = ROUTES.find((r) => r.method === req.method && pathname.startsWith(r.prefix))
      if (!match) {
        sendError(res, 404, 'not_found', `未知 API：${req.method} ${pathname}`)
        return true
      }
      // home 探测与列表路由自己解析参数，不参与统一校验。
      const selfResolved =
        pathname.startsWith('/api/home/') || pathname === '/api/homes'
      const home = selfResolved
        ? (url.searchParams.get('home') ?? '')
        : await resolveRequestedHome(url.searchParams.get('home'))
      const isWrite = req.method !== 'GET' && req.method !== 'HEAD'
      if (isWrite && !isLoopback(req.socket.remoteAddress)) {
        sendError(res, 403, 'read_only', '写操作只能从本机发起')
        return true
      }
      const result = await match.handler({
        home,
        url,
        req,
        body: async <T,>() => {
          const text = await readBody(req, BODY_LIMIT)
          return JSON.parse(text) as T
        },
      })
      sendJson(res, 200, result)
      return true
    } catch (error) {
      if (error instanceof HomeError) {
        sendError(res, error.status, error.code, error.message)
      } else if (error instanceof ConflictError) {
        sendError(res, 409, 'conflict', error.message)
      } else if (error instanceof SyntaxError) {
        sendError(res, 400, 'bad_json', '请求体不是合法 JSON')
      } else {
        const message = error instanceof Error ? error.message : String(error)
        const status = /ENOENT|不存在/.test(message) ? 404 : 500
        sendError(res, status, 'internal', message)
      }
      return true
    }
  }
}
