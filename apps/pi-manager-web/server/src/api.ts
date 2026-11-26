import type http from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { sendError, sendJson, readBody } from './http-util.ts'
import { resolveRequestedHome, defaultHomeIfValid, HomeError, looksLikePiHome } from './pi-home.ts'
import { HomeRegistry, type HomeEntry } from './homes.ts'
import { startSessionTask, getTask, listTasks, cancelSessionTask, taskCapacity } from './session-task.ts'
import { readLiveSessions } from './live-sessions.ts'
import { readSettings, mutateSettings } from './settings-file.ts'
import {
  SETTINGS_BUILTIN_TOOLS,
  assertBuiltinToolNames,
  builtinToolsOf,
  isPowerShellToolEnabled,
  readDefaultTools,
  resolvedToolsOf,
  withBuiltinTools,
  withPowerShell,
} from './tool-settings.ts'
import { ConflictError } from './rw.ts'
import { listSkills, readSkillContent, toggleSkill } from './skills.ts'
import {
  listAgentProfiles,
  readAgentProfile,
  saveAgentProfile,
  deleteAgentProfile,
  readAgentsSettings,
  writeAgentsSettings,
  renderProfile,
  type AgentProfileFields,
} from './agents.ts'
import { readMcp, mergeMcp, patchMcpServer, type McpExposure } from './mcp-file.ts'
import {
  readModels,
  mergeModels,
  readAuth,
  mergeAuth,
  readModelCatalog,
  mergeModelOverride,
  realProviderEntry,
} from './models-auth.ts'
import { readCachedCatalog, refreshCatalog, catalogCwd } from './models-runtime.ts'
import { testProviderModel, discoverProviderModels } from './models-probe.ts'
import { listPackages, applyPackagesMutation } from './plugins.ts'
import { createStaticHandler } from './static.ts'

/**
 * pi-manager-web API：每个请求的 home 都来自 ?home= 参数，服务端无全局状态。
 * 读写接口均不限制来源，安全边界由部署环境的可信局域网承担；凭据字段永不原样回传。
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

const MANAGED_KEYS = [
  'defaultProvider',
  'defaultModel',
  'enabledModels',
  'defaultThinkingLevel',
  'defaultTools',
  'codemode',
  'packages',
  'showCacheMissNotices',
] as const

route('GET', '/api/general', async ({ home }) => {
  const snap = readSettings(home)
  const managed: Record<string, unknown> = {}
  for (const key of MANAGED_KEYS) {
    if (snap.data[key] !== undefined) managed[key] = snap.data[key]
  }
  const defaultTools = readDefaultTools(snap.data)
  return {
    revision: snap.revision,
    path: snap.path,
    managed,
    keyCount: Object.keys(snap.data).length,
    unmanagedKeys: Object.keys(snap.data).filter((k) => !(MANAGED_KEYS as readonly string[]).includes(k)),
    // 内置工具开关的初始状态由 defaultTools 解析得出，与 pi 的启动工具集一致。
    builtinTools: builtinToolsOf(defaultTools),
    builtinToolNames: [...SETTINGS_BUILTIN_TOOLS],
    resolvedTools: resolvedToolsOf(defaultTools),
    isWindows: process.platform === 'win32',
    powerShellEnabled: isPowerShellToolEnabled(defaultTools),
  }
})

/** 内置工具开关：一次写回最小 entries；等于 pi 默认组合时删除 defaultTools。 */
route('PUT', '/api/general/tools', async ({ home, body }) => {
  const payload = await body<{ builtinTools?: unknown; revision?: string }>()
  if (typeof payload.revision !== 'string') throw new HomeError('缺少 revision', 400, 'missing_revision')
  const selected = assertBuiltinToolNames(payload.builtinTools)
  const result = mutateSettings(home, payload.revision, (settings) => {
    const current = readDefaultTools(settings)
    const next = withBuiltinTools(current, selected)
    if (JSON.stringify(current ?? null) === JSON.stringify(next ?? null)) return false
    if (next === undefined) delete settings.defaultTools
    else settings.defaultTools = next
    return true
  })
  return { ok: true, ...result }
})

/** Windows 上的 PowerShell 代替 bash：写回普通名字的工具集。 */
route('PUT', '/api/general/shell', async ({ home, body }) => {
  const payload = await body<{ powerShell?: unknown; revision?: string }>()
  if (typeof payload.powerShell !== 'boolean') throw new HomeError('powerShell 必须是布尔值', 400, 'invalid_request')
  if (process.platform !== 'win32') {
    throw new HomeError('PowerShell 工具设置只在 Windows 上可用', 400, 'not_windows')
  }
  if (typeof payload.revision !== 'string') throw new HomeError('缺少 revision', 400, 'missing_revision')
  const result = mutateSettings(home, payload.revision, (settings) => {
    const current = readDefaultTools(settings)
    const next = withPowerShell(current, payload.powerShell as boolean)
    if (JSON.stringify(current ?? null) === JSON.stringify(next)) return false
    settings.defaultTools = next
    return true
  })
  return { ok: true, ...result }
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

/** 默认模型在 settings.json 里是 defaultProvider + defaultModel 两个独立字符串，必须一起改。 */
route('PUT', '/api/general/model', async ({ home, body }) => {
  const payload = await body<{ provider?: unknown; modelId?: unknown; revision?: unknown }>()
  if (typeof payload.revision !== 'string') throw new HomeError('缺少 revision', 400, 'missing_revision')
  const provider = typeof payload.provider === 'string' ? payload.provider.trim() : ''
  const modelId = typeof payload.modelId === 'string' ? payload.modelId.trim() : ''
  if ((provider === '') !== (modelId === '')) {
    throw new HomeError('provider 与 modelId 必须同时填写或同时清空', 400, 'invalid_request')
  }
  const result = mutateSettings(home, payload.revision, (settings) => {
    const unchanged = (settings.defaultProvider ?? null) === (provider || null) && (settings.defaultModel ?? null) === (modelId || null)
    if (unchanged) return false
    if (provider && modelId) {
      settings.defaultProvider = provider
      settings.defaultModel = modelId
    } else {
      delete settings.defaultProvider
      delete settings.defaultModel
    }
    return true
  })
  return { ok: true, ...result }
})

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

route('GET', '/api/skills', async ({ home }) => listSkills(home))

/** 单个 skill 的完整内容：frontmatter 原条目 + 正文（只读）。 */
route('GET', '/api/skills/content', async ({ home, url }) => {
  const relDir = url.searchParams.get('relDir') ?? ''
  if (!relDir) throw new HomeError('relDir 必填', 400, 'invalid_request')
  return readSkillContent(home, relDir)
})

route('POST', '/api/skills/toggle', async ({ home, body }) => {
  const payload = await body<{ relDir?: string; disabled?: boolean }>()
  if (typeof payload.relDir !== 'string' || typeof payload.disabled !== 'boolean') {
    throw new HomeError('relDir 与 disabled 必填', 400, 'invalid_request')
  }
  return { ok: true, disabled: await toggleSkill(home, payload.relDir, payload.disabled) }
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file)) throw new HomeError('非法文件名', 400, 'invalid_file')
  return readAgentProfile(home, file)
})

route('PUT', '/api/agents/profile', async ({ home, body }) => {
  const payload = await body<{
    file?: string
    name?: string
    description?: string
    fields?: AgentProfileFields
    presentKeys?: unknown
    extraKeys?: unknown
    body?: string
    revision?: string
  }>()
  if (typeof payload.file !== 'string' || typeof payload.name !== 'string' || !payload.name.trim()) {
    throw new HomeError('file 与 name 必填', 400, 'invalid_request')
  }
  if (!payload.fields || typeof payload.fields !== 'object') {
    throw new HomeError('fields 必填', 400, 'invalid_request')
  }
  if (!payload.file.endsWith('.md')) payload.file = `${payload.file}.md`
  // pi 用 frontmatter 的 name 作为 subagent 名；文件名与 name 不一致会造成同名歧义。
  if (payload.file.replace(/\.md$/, '') !== payload.name.trim()) {
    throw new HomeError('文件名必须与 name 一致；改名请新建 profile 并删除旧的', 400, 'name_file_mismatch')
  }
  const path = join(home, 'agents', payload.file)
  const current = existsSync(path) ? readAgentProfile(home, payload.file) : undefined
  const content = renderProfile(
    {
      name: payload.name.trim(),
      description: typeof payload.description === 'string' ? payload.description : '',
      fields: payload.fields,
      presentKeys: Array.isArray(payload.presentKeys)
        ? payload.presentKeys.filter((key): key is string => typeof key === 'string')
        : [],
      extraKeys: Array.isArray(payload.extraKeys)
        ? payload.extraKeys.filter((line): line is string => typeof line === 'string')
        : [],
      body: typeof payload.body === 'string' ? payload.body : '',
    },
    current,
  )
  const revision = await saveAgentProfile(home, payload.file, payload.revision, content)
  return { ok: true, file: payload.file, revision, profile: readAgentProfile(home, payload.file) }
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

/** 只切换一个 server 的 enabled / exposure，不改条目其它字段。 */
route('PUT', '/api/mcp/server', async ({ home, body }) => {
  const payload = await body<{
    name?: unknown
    enabled?: unknown
    exposure?: unknown
    revision?: unknown
  }>()
  if (typeof payload.name !== 'string' || !payload.name) throw new HomeError('name 必填', 400, 'invalid_request')
  if (typeof payload.revision !== 'string') throw new HomeError('缺少 revision', 400, 'missing_revision')
  if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') {
    throw new HomeError('enabled 必须是布尔值', 400, 'invalid_request')
  }
  if (
    payload.exposure !== undefined
    && payload.exposure !== 'direct'
    && payload.exposure !== 'deferred'
    && payload.exposure !== 'codemode'
  ) {
    throw new HomeError('exposure 只能是 direct / deferred / codemode', 400, 'invalid_request')
  }
  const revision = await patchMcpServer(home, payload.revision, payload.name, {
    enabled: payload.enabled as boolean | undefined,
    exposure: payload.exposure as McpExposure | undefined,
  })
  return { ok: true, revision }
})

// ---------------------------------------------------------------------------
// models + auth
// ---------------------------------------------------------------------------

route('GET', '/api/models', async ({ home }) => readModels(home))

/**
 * 写一个模型的 modelOverrides（models.json）。
 * pi 用它对内置或扩展提供的模型改 contextWindow / maxTokens / reasoning / input，
 * 不替换 provider 的模型列表——这是扩展注册 provider 唯一的元数据配置入口。
 */
route('PUT', '/api/models/override', async ({ home, body }) => {
  const payload = await body<{
    provider?: unknown
    modelId?: unknown
    override?: unknown
    revision?: unknown
  }>()
  if (typeof payload.provider !== 'string' || typeof payload.modelId !== 'string') {
    throw new HomeError('provider 与 modelId 必填', 400, 'invalid_request')
  }
  if (typeof payload.revision !== 'string') throw new HomeError('缺少 revision', 400, 'missing_revision')
  if (payload.override !== null && (typeof payload.override !== 'object' || Array.isArray(payload.override))) {
    throw new HomeError('override 必须是对象或 null', 400, 'invalid_request')
  }
  const revision = await mergeModelOverride(
    home,
    payload.revision,
    payload.provider,
    payload.modelId,
    payload.override as Record<string, unknown> | null,
  )
  return { ok: true, revision }
})

/** 本机模型清单：settings 的默认/启用模型 + models.json + models-store + 运行时目录（含 context/maxOut）。 */
function buildCatalog(home: string) {
  return readModelCatalog(home, readSettings(home).data, readCachedCatalog(home, catalogCwd()))
}

route('GET', '/api/models/catalog', async ({ home }) => buildCatalog(home))
/**
 * 刷新运行时模型目录。会加载该 home 的扩展（provider 扩展会访问网关），因此
 * 只在显式请求时做；结果缓存到状态目录，供后续 GET /api/models/catalog 使用。
 */
route('POST', '/api/models/catalog/refresh', async ({ home }) => {
  const catalog = await refreshCatalog(home, catalogCwd())
  return { ok: true, fetchedAt: catalog.fetchedAt, modelCount: catalog.models.length, ...buildCatalog(home) }
})

route('PUT', '/api/models/providers', async ({ home, body }) => {
  const payload = await body<{ providers?: Record<string, Record<string, unknown> | null>; revision?: string }>()
  if (typeof payload.revision !== 'string') throw new HomeError('缺少 revision', 400, 'missing_revision')
  const revision = await mergeModels(home, payload.revision, payload.providers ?? {})
  return { ok: true, revision }
})

/** 测试一个草稿模型：临时 models.json + 该 home 的 auth.json，发一次真实请求。 */
route('POST', '/api/models/test', async ({ home, body }) => {
  const payload = await body<{ providerName?: unknown; provider?: unknown; model?: unknown }>()
  if (typeof payload.providerName !== 'string' || !payload.providerName.trim()) {
    throw new HomeError('providerName 必填', 400, 'invalid_request')
  }
  if (!payload.provider || typeof payload.provider !== 'object' || Array.isArray(payload.provider)) {
    throw new HomeError('provider 必填', 400, 'invalid_request')
  }
  if (!payload.model || typeof payload.model !== 'object' || Array.isArray(payload.model)) {
    throw new HomeError('model 必填', 400, 'invalid_request')
  }
  const providerName = payload.providerName.trim()
  return testProviderModel(
    home,
    providerName,
    realProviderEntry(home, providerName, payload.provider as Record<string, unknown>),
    payload.model as Record<string, unknown>,
  )
})

/** 拉取上游 /models 列表（不写文件）。 */
route('POST', '/api/models/discover', async ({ home, body }) => {
  const payload = await body<{ providerName?: unknown; provider?: unknown }>()
  if (typeof payload.providerName !== 'string' || !payload.providerName.trim()) {
    throw new HomeError('providerName 必填', 400, 'invalid_request')
  }
  if (!payload.provider || typeof payload.provider !== 'object' || Array.isArray(payload.provider)) {
    throw new HomeError('provider 必填', 400, 'invalid_request')
  }
  const providerName = payload.providerName.trim()
  return discoverProviderModels(
    home,
    providerName,
    realProviderEntry(home, providerName, payload.provider as Record<string, unknown>),
  )
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
// session：按 agent 身份（pi home 的 name）执行一次会话任务
//
// agent 身份就是一份 pi home：它带自己的模型、凭据、skills 与 agents，
// 因此不同 home 里的同名 profile 属于不同 agent。调用方用 name 指定。
// ---------------------------------------------------------------------------

/** 把 agent 参数解析成清单条目：name 优先，也接受 id 与绝对路径便于脚本使用。 */
function resolveAgent(raw: unknown): HomeEntry {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new HomeError('agent 必填（pi home 的名称）', 400, 'invalid_request')
  }
  const key = raw.trim()
  const byName = homes.findByName(key)
  if (byName) return byName
  const byId = homes.get(key)
  if (byId) return byId
  if (key.startsWith('/')) {
    for (const entry of homes.list()) {
      if (entry.path === key && entry.listed) return { id: entry.id, name: entry.name, path: entry.path, description: entry.description }
    }
  }
  const known = homes.list().filter((h) => h.listed).map((h) => h.name)
  throw new HomeError(
    `没有这个 agent：${key}${known.length ? `（可用：${known.join('、')}）` : '（清单为空，先在侧边栏新增 pi home）'}`,
    404,
    'agent_not_found',
  )
}

/** 发起一次会话：立即返回 session id，后台执行，结果用 GET 查询。 */
route('POST', '/api/session/prompt', async ({ body }) => {
  const payload = await body<{
    agent?: unknown
    instruct?: unknown
    subagent?: unknown
    cwd?: unknown
    model?: unknown
    thinkingLevel?: unknown
  }>()
  const agent = resolveAgent(payload.agent)
  if (typeof payload.instruct !== 'string' || !payload.instruct.trim()) {
    throw new HomeError('instruct 必填', 400, 'invalid_request')
  }
  // home 已由 agent 决定；仍走一次 realpath 校验，保证目录没被删掉或换掉。
  const home = await resolveRequestedHome(agent.path)
  const task = await startSessionTask({
    agent: agent.name,
    home,
    subagent:
      typeof payload.subagent === 'string' && payload.subagent.trim()
        ? payload.subagent.trim()
        : null,
    instruct: payload.instruct,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
    model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined,
    thinkingLevel:
      typeof payload.thinkingLevel === 'string' && payload.thinkingLevel.trim()
        ? payload.thinkingLevel.trim()
        : undefined,
  })
  return {
    sessionId: task.sessionId,
    sessionFile: task.sessionFile,
    state: task.state,
    agent: task.agent,
    subagent: task.subagent,
    startedAt: task.startedAt,
  }
})

route('GET', '/api/session/task', async ({ url }) => {
  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId) throw new HomeError('sessionId 必填', 400, 'invalid_request')
  const task = getTask(sessionId)
  if (!task) throw new HomeError(`没有这个会话任务：${sessionId}`, 404, 'task_not_found')
  return { task, capacity: taskCapacity() }
})

/** 任务列表：可按 agent（home 名）过滤；不传则列出全部。 */
route('GET', '/api/session/tasks', async ({ url }) => {
  const raw = url.searchParams.get('agent')
  if (!raw || !raw.trim()) return { tasks: listTasks(), capacity: taskCapacity() }
  const agent = resolveAgent(raw)
  return { tasks: listTasks(agent.path), capacity: taskCapacity() }
})

/**
 * 该 home 的跨进程运行态：读心跳扩展写的文件，与任务表无关。
 * 路径在 /api/session/ 下，路由层不预校验 home，这里自己 realpath。
 */
route('GET', '/api/session/live', async ({ url }) => {
  const home = await resolveRequestedHome(url.searchParams.get('home'))
  return readLiveSessions(home)
})

route('POST', '/api/session/cancel', async ({ body }) => {
  const payload = await body<{ sessionId?: unknown }>()
  if (typeof payload.sessionId !== 'string' || !payload.sessionId) {
    throw new HomeError('sessionId 必填', 400, 'invalid_request')
  }
  await cancelSessionTask(payload.sessionId)
  return { ok: true }
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
      // 同一方法的候选里取最长前缀：/api/session/tasks 不能被 /api/session/task 抢走。
      const match = ROUTES.filter((r) => r.method === req.method && pathname.startsWith(r.prefix)).sort(
        (a, b) => b.prefix.length - a.prefix.length,
      )[0]
      if (!match) {
        sendError(res, 404, 'not_found', `未知 API：${req.method} ${pathname}`)
        return true
      }
      // home 探测与列表路由自己解析参数，不参与统一校验。
      const selfResolved =
        pathname.startsWith('/api/home/') ||
        pathname === '/api/homes' ||
        pathname.startsWith('/api/session/')
      const home = selfResolved
        ? (url.searchParams.get('home') ?? '')
        : await resolveRequestedHome(url.searchParams.get('home'))
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
