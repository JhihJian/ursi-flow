import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { HANDLED, route } from '../http/router.ts'
import { HomeError, resolveRequestedHome } from '../shared/pi-home.ts'
import { homes } from '../config/registry.ts'
import {
  capabilitiesOf,
  collectionCursor,
  originOfRoot,
  getEntity,
  heartbeatPluginFound,
  homeOrigin,
  listEntities,
  project,
  touchExternalRoot,
  transition,
  type PiSession,
  type SessionOrigin,
  type SessionState,
} from './registry.ts'
import type { SessionService } from './service.ts'

/**
 * 会话域路由：所有读写都以实体 id 为准，路径里的 `:id` 就是 `sessionId`。
 * 作用域由 `home`（home 路径或 id）或 `root`（任意目录）给出。
 *
 * 本域只持有磁盘事实。装配运行时、跑一轮消息属于 runtime 域：这些动作由组合根
 * （`server.ts`）把运行时能力注入进来，会话域不 import 它。
 */

let service: SessionService | null = null

export function setSessionService(next: SessionService): void {
  service = next
}

function requireService(): SessionService {
  if (!service) throw new HomeError('会话服务未初始化', 500, 'service_missing')
  return service
}

/**
 * 会话域需要的运行时能力，只声明形状、不关心实现。
 *
 * 返回体由路由原样回给客户端，会话域只取 `sessionId` 去拿实体。
 */
export interface SessionRuntime {
  /** 新建或续接对话；返回的 sessionId 与实体 id 相同。 */
  createChat(options: {
    home: string
    cwd?: string
    model?: string
    thinkingLevel?: string
    subagent?: string | null
    sessionFile?: string | null
  }): Promise<{ sessionId: string }>
  /** 起一次性会话任务；返回的 sessionId 与实体 id 相同。 */
  startSessionTask(options: {
    agent: string
    home: string
    subagent: string | null
    instruct: string
    cwd?: string
    model?: string
    thinkingLevel?: string
  }): Promise<{ sessionId: string }>
  /** 本地运行时的权威行文本；没有本地运行时返回 null。 */
  chatTranscript(sessionId: string): string | null
}

let runtime: SessionRuntime | null = null

export function setSessionRuntime(next: SessionRuntime): void {
  runtime = next
}

function requireRuntime(): SessionRuntime {
  if (!runtime) throw new HomeError('会话运行时未初始化', 500, 'runtime_missing')
  return runtime
}

/** 所有已登记 / 已发现的有效 home 路径：会话根清单用。 */
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
    return { ...cursor, notModified: true, pendingDetails, truncated, heartbeatDetected: heartbeatPluginFound() }
  }
  return {
    ...cursor,
    sessions: entities,
    pendingDetails,
    truncated,
    /** 心跳插件是否装在任一 home：会话视图的运行态功能以此为开关。心跳合流由运行时域定时做。 */
    heartbeatDetected: heartbeatPluginFound(),
    ...(origin?.kind === 'home' ? { homeId: origin.homeId } : {}),
    ...(origin?.kind === 'external' ? { root: origin.rootPath } : {}),
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

/**
 * 建会话的 home：新建必须传；续聊可以不传，按实体归属取。
 * 路由键只有 sessionId，会话文件只是实体的属性，不接受按路径反查。
 */
async function resolveHomeForCreate(homeRaw: string | null, sessionId: string | null): Promise<string> {
  if (homeRaw) {
    const summary = homes.list().find((entry) => entry.id === homeRaw || entry.path === homeRaw)
    return resolveRequestedHome(summary ? summary.path : homeRaw)
  }
  if (!sessionId) throw new HomeError('home 必填', 400, 'invalid_home')
  const entity = getEntity(sessionId)
  if (!entity) throw new HomeError(`没有这个会话：${sessionId}`, 404, 'session_absent')
  if (entity.origin.kind === 'home') return resolveRequestedHome(entity.origin.homePath)
  throw new HomeError(
    `会话不属于任何已登记的 pi home：${sessionId}`,
    404,
    'home_not_found',
  )
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
    /** 续聊：在已有实体上装配运行时，home 按实体归属取。 */
    sessionId?: unknown
  }>()
  const resumeId =
    typeof payload.sessionId === 'string' && payload.sessionId.trim() ? payload.sessionId.trim() : null
  const homeRaw =
    typeof payload.home === 'string' && payload.home.trim()
      ? payload.home.trim()
      : typeof payload.homeId === 'string' && payload.homeId.trim()
        ? payload.homeId.trim()
        : null
  const home = await resolveHomeForCreate(homeRaw, resumeId)
  const kind = payload.kind === 'task' ? 'task' : 'chat'

  if (kind === 'task') {
    if (typeof payload.instruct !== 'string' || !payload.instruct.trim()) {
      throw new HomeError('instruct 必填', 400, 'invalid_request')
    }
    const task = await requireRuntime().startSessionTask({
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

  if (resumeId && (typeof payload.cwd === 'string' && payload.cwd.trim())) {
    throw new HomeError('续聊不接受 cwd：会话文件里已经记录了工作目录', 400, 'invalid_request')
  }
  // 续聊的会话文件就是实体的 filePath；能否续聊由实体的 capabilities 给出，不在这里重算。
  const resumeEntity = resumeId ? requireEntity(resumeId) : null
  if (resumeEntity) {
    assertFreeToAttach(resumeEntity)
    const { canContinue, reason } = capabilitiesOf(resumeEntity)
    if (!canContinue) {
      throw new HomeError(`这条会话不能续聊：${reason ?? '当前状态不允许'}`, 409, 'session_not_continuable')
    }
    if (!resumeEntity.filePath) {
      throw new HomeError(`会话还没有落盘，不能续聊：${resumeId}`, 409, 'session_not_persisted')
    }
    // 先把实体标成「装配中」：并发的 turn / model / delete 拿到 409，而不是又装一份运行时。
    transition(resumeEntity.id, 'loading')
  }

  const chat = await requireRuntime().createChat({
    home,
    cwd: typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : undefined,
    model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined,
    thinkingLevel:
      typeof payload.thinkingLevel === 'string' && payload.thinkingLevel.trim()
        ? payload.thinkingLevel.trim()
        : undefined,
    subagent: typeof payload.subagent === 'string' && payload.subagent.trim() ? payload.subagent.trim() : null,
    // 文件头的 id 就是实体 id，SessionManager.open 之后拿到的是同一个身份。
    sessionFile: resumeEntity?.filePath ?? null,
  })
  const entity = getEntity(chat.sessionId)
  return { session: entity ? project(entity) : null, chat }
})

function requireEntity(id: string) {
  const entity = getEntity(id)
  if (!entity) throw new HomeError(`没有这个会话：${id}`, 404, 'session_absent')
  return entity
}

/**
 * 同机另一个 pi 进程正在跑这条会话时本服务只读：两个运行时追同一个会话文件会双写。
 *
 * 这里只读实体的 capabilities，不 import runtime；跨机心跳不拦（v1 允许双开，
 * live 事实以会话文件为准）。
 */
function assertFreeToAttach(entity: PiSession): void {
  if (capabilitiesOf(entity).reason !== 'runtime_elsewhere') return
  throw new HomeError(
    '这条会话正被同机的另一个 pi 进程使用，本服务只读：先关掉那个进程再续聊',
    409,
    'runtime_elsewhere',
  )
}

route('GET', '/api/sessions/:id', 'none', async ({ params }) => project(requireEntity(params.id)))

/** 轨迹：有本地运行时用它的权威行文本，否则读文件；两者同一份返回形状。 */
route('GET', '/api/sessions/:id/trajectory', 'none', async ({ params, req, res }) => {
  const entity = requireEntity(params.id)
  const local = entity.runtimes.some((fact) => fact.origin === 'local')
  if (local) {
    const jsonl = requireRuntime().chatTranscript(entity.id)
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
