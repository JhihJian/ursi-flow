import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { HANDLED, route } from '../http/router.ts'
import { HomeError, resolveRequestedHome } from '../shared/pi-home.ts'
import { uriOf } from '../shared/locate.ts'
import { homes, requireHome } from '../config/registry.ts'
import { MAX_TEXT_BYTES, SESSIONS_ROOT } from '../config.ts'
import {
  collectionCursor,
  originOfRoot,
  findByPath,
  getEntity,
  homeOrigin,
  listEntities,
  project,
  touchExternalRoot,
  type SessionOrigin,
  type SessionState,
} from './registry.ts'
import type { SessionService } from './service.ts'
import { syncLiveSessions } from '../chat/live-sessions.ts'

/**
 * 会话域路由：所有读写都以实体 id 为准，路径里的 `:id` 就是 `sessionId`。
 * 作用域由 `home`（home 路径或 id）或 `root`（任意目录）给出。
 */

let service: SessionService | null = null

export function setSessionService(next: SessionService): void {
  service = next
}

function requireService(): SessionService {
  if (!service) throw new HomeError('会话服务未初始化', 500, 'service_missing')
  return service
}

/** 所有已登记 / 已发现的有效 home 路径：心跳汇总要用。 */
function homePaths(): string[] {
  const paths: string[] = []
  for (const entry of homes.list()) {
    if (entry.valid && !paths.includes(entry.path)) paths.push(entry.path)
  }
  return paths
}

async function originFromQuery(url: URL): Promise<SessionOrigin | null> {
  const root = url.searchParams.get('root')
  if (root && root.trim()) {
    const path = await requireService().resolveRoot(root)
    const origin = originOfRoot(path)
    if (origin.kind === 'external') touchExternalRoot(path)
    return origin
  }
  const home = url.searchParams.get('home')
  if (home && home.trim()) {
    const trimmed = home.trim()
    // 既接受路径，也接受 homeId：前端手里通常只有实体。
    const byId = homes.list().find((entry) => entry.id === trimmed)
    const path = byId ? byId.path : await resolveRequestedHome(trimmed)
    return homeOrigin(path)
  }
  return null
}

route('GET', '/api/sessions', 'none', async ({ url }) => {
  const svc = requireService()
  const live = syncLiveSessions(homePaths())
  const origin = await originFromQuery(url)
  let pendingDetails = 0
  let truncated = false
  if (origin) {
    const listing = await svc.list(origin)
    pendingDetails = listing.pendingDetails
    truncated = listing.truncated
  }
  const state = url.searchParams.get('state') as SessionState | 'live' | null
  const kind = url.searchParams.get('kind') as never
  const entities = listEntities({
    ...(origin ? { origin } : {}),
    ...(state ? { state } : {}),
    ...(kind ? { kind } : {}),
    ...(url.searchParams.get('parentFile') ? { parentFile: url.searchParams.get('parentFile') as string } : {}),
    ...(url.searchParams.get('q') ? { query: url.searchParams.get('q') as string } : {}),
  }).map(project)

  const cursor = collectionCursor()
  const since = Number(url.searchParams.get('since') ?? '')
  if (Number.isFinite(since) && since === cursor.revision) {
    return { ...cursor, notModified: true, pendingDetails, truncated, heartbeatDetected: live.pluginDetected }
  }
  return {
    ...cursor,
    sessions: entities,
    pendingDetails,
    truncated,
    /** 心跳插件是否装在任一 home：会话视图的运行态功能以此为开关。 */
    heartbeatDetected: live.pluginDetected,
    ...(origin?.kind === 'home' ? { homeId: origin.homeId } : {}),
    ...(origin?.kind === 'external' ? { root: origin.rootPath } : {}),
  }
})

route('GET', '/api/sessions/config', 'none', async () => {
  const defaultRoot = SESSIONS_ROOT || join(homes.list().find((entry) => entry.valid)?.path ?? '', 'sessions')
  return {
    defaultRoot,
    suggestedRoots: homePaths().map((path) => join(path, 'sessions')),
    maxTextBytes: MAX_TEXT_BYTES,
  }
})

route('GET', '/api/sessions/browse', 'none', async ({ url }) => {
  const svc = requireService()
  const target = url.searchParams.get('path') || url.searchParams.get('root')
  const path = await svc.resolveRoot(target)
  const listing = await svc.scanner.browse(path)
  if (!listing) throw new HomeError(`无法读取目录：${path}`, 400, 'browse_failed')
  // 对外说 URI；扫描器内部以裸路径为键。
  return {
    path: uriOf(listing.path),
    parent: listing.parent ? uriOf(listing.parent) : null,
    dirs: listing.dirs.map((dir) => ({ ...dir, path: uriOf(dir.path) })),
  }
})

route('GET', '/api/sessions/prefs', 'none', async () => requireService().prefs.get())

route('PUT', '/api/sessions/prefs', 'none', async ({ body }) => {
  const payload = await body<{ pin?: unknown; unpin?: unknown }>()
  if (payload.pin !== undefined && typeof payload.pin !== 'string') {
    throw new HomeError('pin 必须是 projectKey 字符串', 400, 'invalid_prefs')
  }
  if (payload.unpin !== undefined && typeof payload.unpin !== 'string') {
    throw new HomeError('unpin 必须是 projectKey 字符串', 400, 'invalid_prefs')
  }
  if (payload.pin === undefined && payload.unpin === undefined) {
    throw new HomeError('需要 pin 或 unpin', 400, 'invalid_prefs')
  }
  const result = await requireService().prefs.apply({
    ...(payload.pin !== undefined ? { pin: payload.pin as string } : {}),
    ...(payload.unpin !== undefined ? { unpin: payload.unpin as string } : {}),
  })
  return { pinnedProjects: result.pinnedProjects }
})

async function resolveHomeForCreate(homeRaw: string | null, sessionFile: string | null): Promise<string> {
  if (homeRaw) {
    const summary = homes.list().find((entry) => entry.id === homeRaw || entry.path === homeRaw)
    return resolveRequestedHome(summary ? summary.path : homeRaw)
  }
  if (!sessionFile) throw new HomeError('home 必填', 400, 'invalid_home')
  const entity = findByPath(sessionFile)
  if (entity?.origin.kind === 'home') return resolveRequestedHome(entity.origin.homePath)
  for (const entry of homes.list()) {
    if (!entry.valid) continue
    if (sessionFile.startsWith(`${join(entry.path, 'sessions')}/`)) return resolveRequestedHome(entry.path)
  }
  throw new HomeError(`会话文件不属于任何已登记的 pi home：${sessionFile}`, 404, 'home_not_found')
}

/** 建会话或起任务：实体在返回前就已经存在，客户端拿到的是同一个 id。 */
route('POST', '/api/sessions', 'none', async ({ body }) => {
  const payload = await body<{
    home?: unknown
    homeId?: unknown
    kind?: unknown
    cwd?: unknown
    model?: unknown
    thinkingLevel?: unknown
    subagent?: unknown
    instruct?: unknown
    timeoutMs?: unknown
    sessionFile?: unknown
  }>()
  const sessionFileRaw =
    typeof payload.sessionFile === 'string' && payload.sessionFile.trim() ? payload.sessionFile.trim() : null
  const homeRaw =
    typeof payload.home === 'string' && payload.home.trim()
      ? payload.home.trim()
      : typeof payload.homeId === 'string' && payload.homeId.trim()
        ? payload.homeId.trim()
        : null
  // 续聊可以不传 home：按会话文件找它所属的 home（实体优先，其次按 sessions 根前缀）。
  const home = await resolveHomeForCreate(homeRaw, sessionFileRaw)
  const kind = payload.kind === 'task' ? 'task' : 'chat'

  if (kind === 'task') {
    if (typeof payload.instruct !== 'string' || !payload.instruct.trim()) {
      throw new HomeError('instruct 必填', 400, 'invalid_request')
    }
    const { startSessionTask } = await import('../chat/session-task.ts')
    const task = await startSessionTask({
      agent: homes.list().find((entry) => entry.path === home)?.name ?? home,
      home,
      subagent: typeof payload.subagent === 'string' && payload.subagent.trim() ? payload.subagent.trim() : null,
      instruct: payload.instruct,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
      model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined,
      thinkingLevel:
        typeof payload.thinkingLevel === 'string' && payload.thinkingLevel.trim()
          ? payload.thinkingLevel.trim()
          : undefined,
    })
    const entity = getEntity(task.sessionId)
    return { session: entity ? project(entity) : null, task }
  }

  const { createChat } = await import('../chat/chat.ts')
  const chat = await createChat({
    home,
    cwd: typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : undefined,
    model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined,
    thinkingLevel:
      typeof payload.thinkingLevel === 'string' && payload.thinkingLevel.trim()
        ? payload.thinkingLevel.trim()
        : undefined,
    subagent: typeof payload.subagent === 'string' && payload.subagent.trim() ? payload.subagent.trim() : null,
    sessionFile: sessionFileRaw,
  })
  const entity = getEntity(chat.sessionId)
  return { session: entity ? project(entity) : null, chat }
})

function requireEntity(id: string) {
  const entity = getEntity(id)
  if (!entity) throw new HomeError(`没有这个会话：${id}`, 404, 'session_absent')
  return entity
}

route('GET', '/api/sessions/:id', 'none', async ({ params }) => project(requireEntity(params.id)))

/** 轨迹：有本地运行时用它的权威行文本，否则读文件；两者同一份返回形状。 */
route('GET', '/api/sessions/:id/trajectory', 'none', async ({ params, req, res }) => {
  const entity = requireEntity(params.id)
  const local = entity.runtimes.some((fact) => fact.origin === 'local')
  if (local) {
    const { chatTranscript } = await import('../chat/chat.ts')
    const jsonl = chatTranscript(entity.id)
    if (jsonl !== null) {
      const info = entity.filePath ? await stat(entity.filePath).catch(() => null) : null
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(
        JSON.stringify({
          sessionId: entity.id,
          revision: `${info?.mtimeMs ?? 0}.${info?.size ?? 0}`,
          source: 'runtime',
          format: entity.disk?.format ?? 'pi',
          text: jsonl,
          complete: true,
          reset: true,
        }),
      )
      return HANDLED
    }
  }
  // 文件形态：逐行转换成组件库认的形状后流式输出，可 gzip。
  await requireService().streamText(entity, res, String(req.headers['accept-encoding'] ?? ''))
  return HANDLED
})

/** 事件流：只有存在本地运行时的会话有增量；其它会话由客户端轮询集合。 */
route('GET', '/api/sessions/:id/events', 'none', async ({ params, req, res }) => {
  const entity = requireEntity(params.id)
  if (!entity.runtimes.some((fact) => fact.origin === 'local')) {
    throw new HomeError('该会话没有本地运行时', 409, 'session_not_local')
  }
  const { attachChatStream } = await import('../chat/chat.ts')
  attachChatStream(entity.id, req, res)
  return HANDLED
})

route('POST', '/api/sessions/:id/turn', 'none', async ({ params, body, res }) => {
  const entity = requireEntity(params.id)
  if (entity.state === 'loading') throw new HomeError('会话正在装配，稍后再试', 409, 'session_loading')
  const payload = await body<{ text?: unknown; mode?: unknown }>()
  if (typeof payload.text !== 'string') throw new HomeError('text 必填', 400, 'invalid_request')
  const { promptChat } = await import('../chat/chat.ts')
  const result = await promptChat(
    entity.id,
    payload.text,
    payload.mode === 'steer' ? 'steer' : 'followUp',
  )
  const updated = getEntity(entity.id)
  res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify({ ...result, session: updated ? project(updated) : null }))
  return HANDLED
})

route('POST', '/api/sessions/:id/abort', 'none', async ({ params }) => {
  requireEntity(params.id)
  const { abortChat } = await import('../chat/chat.ts')
  return abortChat(params.id)
})

route('POST', '/api/sessions/:id/interaction', 'none', async ({ params, body }) => {
  requireEntity(params.id)
  const payload = await body<{ interactionId?: unknown; requestId?: unknown; value?: unknown }>()
  const requestId = payload.interactionId ?? payload.requestId
  if (typeof requestId !== 'string' || !requestId) {
    throw new HomeError('interactionId 必填', 400, 'invalid_request')
  }
  const { answerUiRequest } = await import('../chat/chat.ts')
  answerUiRequest(params.id, requestId, payload.value)
  return { ok: true }
})

route('POST', '/api/sessions/:id/model', 'none', async ({ params, body }) => {
  const entity = requireEntity(params.id)
  if (entity.state === 'loading') throw new HomeError('会话正在装配，稍后再试', 409, 'session_loading')
  const payload = await body<{ provider?: unknown; modelId?: unknown; thinkingLevel?: unknown }>()
  if (typeof payload.provider !== 'string' || !payload.provider.trim()) {
    throw new HomeError('provider 必填', 400, 'invalid_request')
  }
  const { setChatModel } = await import('../chat/chat.ts')
  return setChatModel(
    entity.id,
    payload.provider.trim(),
    typeof payload.modelId === 'string' && payload.modelId.trim() ? payload.modelId.trim() : undefined,
    typeof payload.thinkingLevel === 'string' && payload.thinkingLevel.trim()
      ? payload.thinkingLevel.trim()
      : undefined,
  )
})

route('POST', '/api/sessions/:id/evict', 'none', async ({ params }) => {
  requireEntity(params.id)
  const { closeChat } = await import('../chat/chat.ts')
  await closeChat(params.id)
  return { ok: true }
})

route('DELETE', '/api/sessions/:id', 'none', async ({ params }) => {
  const entity = requireEntity(params.id)
  if (entity.state === 'running') throw new HomeError('会话正在运行，先中止再删除', 409, 'session_busy')
  if (entity.state === 'loading') throw new HomeError('会话正在装配，稍后再删', 409, 'session_loading')
  if (!entity.filePath) throw new HomeError('会话还没有落盘文件', 409, 'session_memory_only')
  const root =
    entity.origin.kind === 'home' ? join(entity.origin.homePath, 'sessions') : entity.origin.rootPath
  const removed = await requireService().remove(entity, root)
  return { id: entity.id, removed }
})

/** 会话根的只读查询：外部目录与 home 都走同一套校验。 */
route('GET', '/api/sessions/roots', 'none', async ({ url }) => {
  const target = url.searchParams.get('home') ?? ''
  if (!target.trim()) {
    return { homes: homePaths().map((path) => ({ path, root: join(path, 'sessions'), exists: existsSync(join(path, 'sessions')) })) }
  }
  const path = await resolveRequestedHome(target)
  const root = join(path, 'sessions')
  return { path, root, exists: existsSync(root) }
})
