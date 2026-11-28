import { hostname } from 'node:os'
import { join } from 'node:path'
import { homeIdOf } from '../config/homes.ts'
import { homes } from '../config/registry.ts'
import { EPOCH, EXTERNAL_ROOT_LIMIT, EXTERNAL_ROOT_TTL_MS } from '../config.ts'
import { ConflictError } from '../shared/rw.ts'

/**
 * 会话实体注册表：Pi Web 单一真源。
 *
 * 磁盘扫描、对话运行时、一次性任务、跨进程心跳都往这一张表里写各自的字段，
 * 读者（三个视图）只读同一份对象。字段归属见 docs/design/pi-web/OVERVIEW.md：
 * `disk` 归扫描器，`state`/`queue`/`error`/`execution` 归状态机，`runtimes` 按来源分区。
 */

export type SessionState =
  | 'discovered'
  | 'loading'
  | 'ready'
  | 'running'
  | 'failed'
  | 'evicted'

export type SessionKind = 'chat' | 'task' | 'cli' | 'subagent'

export type SessionOrigin =
  | { kind: 'home'; homeId: string; homePath: string }
  | { kind: 'external'; rootPath: string }

export interface RuntimeFact {
  instanceId: string
  origin: 'local' | 'process'
  host: string
  pid: number
  status: 'idle' | 'running'
  updatedAt: number
}

export interface DiskFacts {
  size: number
  mtime: number
  format: 'pi' | 'legacy' | 'unknown'
  messageCount: number
  firstMessage: string
  createdAt: number
  updatedAt: number
  projectKey: string
  projectName: string
  projectDir: string
}

export interface TaskExecution {
  timeoutMs: number
  outcome: 'running' | 'ok' | 'error' | 'cancelled'
  outputLength: number
  lastText: string
}

export interface PiSessionCapabilities {
  canLoad: boolean
  canTurn: boolean
  canEvict: boolean
  canDelete: boolean
  canContinue: boolean
  reason?: string
}

export interface PiSession {
  id: string
  identitySource: 'minted' | 'header' | 'derived'
  origin: SessionOrigin
  kind: SessionKind
  parentFile: string | null
  persistence: 'memory' | 'file'
  filePath: string | null
  cwd: string
  title: string | null
  disk: DiskFacts | null
  state: SessionState
  stateSince: number
  error: { message: string; phase: 'assemble' | 'turn' } | null
  runtimes: RuntimeFact[]
  model: { provider: string; modelId: string; thinkingLevel: string } | null
  queue: number
  interactions: number
  execution: TaskExecution | null
  profileRevision: number
  /** 实体被注册表记录的时刻，用于稳定排序与外部根回收。 */
  seenAt: number
}

export interface DiskRow {
  id: string
  path: string
  projectDir: string
  projectKey: string
  projectName: string
  cwd: string
  name?: string
  firstMessage: string
  messageCount: number
  created: number
  modified: number
  size: number
  format: 'pi' | 'legacy' | 'unknown'
  detailsPending: boolean
}

export interface RuntimeSnapshot {
  sessionId: string
  kind: SessionKind
  homePath: string
  filePath: string | null
  cwd: string
  title?: string | null
  /** 目标状态：只声明运行时能直接到达的那几种，其余（loading / evicted）走 transition 与 detachRuntime。 */
  toState: 'ready' | 'running' | 'failed'
  model?: { provider: string; modelId: string; thinkingLevel: string } | null
  queue?: number
  interactions?: number
  error?: { message: string; phase: 'assemble' | 'turn' } | null
  profileRevision?: number
  execution?: TaskExecution | null
  instanceId: string
}

/**
 * 合法迁移表：状态只能沿这张表走，装配（loading）与释放（evicted）各有自己的入口。
 *
 * `failed` 可以直接回到 `running`：上一轮失败的对话运行时还活着，重试不必重新装配；
 * 需要重新装配时走 `failed → loading`。
 */
const TRANSITIONS: Record<SessionState, SessionState[]> = {
  discovered: ['loading'],
  loading: ['ready', 'failed'],
  ready: ['running', 'failed', 'evicted'],
  running: ['ready', 'failed', 'evicted'],
  failed: ['loading', 'running', 'evicted'],
  evicted: ['loading'],
}

const LOCAL_HOST = hostname()

const entities = new Map<string, PiSession>()
let revision = 0

function bump(): void {
  revision += 1
}

export function collectionCursor(): { epoch: string; revision: number } {
  return { epoch: EPOCH, revision }
}

export function scopeKeyOf(origin: SessionOrigin): string {
  return origin.kind === 'home' ? `home:${origin.homeId}` : `root:${origin.rootPath}`
}

/**
 * 外部根 LRU：只保留有限个扫描目标，空闲超 TTL 或超限时最旧的被移出，
 * 其下的 discovered 实体一起移除（文件不动）。
 */
const externalRoots = new Map<string, { lastUsed: number }>()

export function touchExternalRoot(root: string): void {
  externalRoots.set(root, { lastUsed: Date.now() })
  const overflow = externalRoots.size - EXTERNAL_ROOT_LIMIT
  if (overflow > 0) {
    const victims = [...externalRoots.entries()]
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .slice(0, overflow)
    for (const [path] of victims) dropExternalRoot(path)
  }
}

function dropExternalRoot(root: string): void {
  externalRoots.delete(root)
  for (const entity of [...entities.values()]) {
    if (entity.origin.kind !== 'external' || entity.origin.rootPath !== root) continue
    // 有本地运行时的会话不在这里移除：它的文件还在被写，交给运行时释放后再回收。
    if (entity.runtimes.some((fact) => fact.origin === 'local')) continue
    entities.delete(entity.id)
    bump()
  }
}

export function sweepExternalRoots(now = Date.now()): void {
  for (const [root, state] of [...externalRoots.entries()]) {
    if (now - state.lastUsed > EXTERNAL_ROOT_TTL_MS) dropExternalRoot(root)
  }
}

export function homeOrigin(homePath: string): SessionOrigin {
  return { kind: 'home', homeId: homeIdOf(homePath), homePath }
}

export function externalOrigin(rootPath: string): SessionOrigin {
  return { kind: 'external', rootPath }
}

/**
 * 一个扫描目录的归属：正好是某个已登记 home 的 sessions/ 就归该 home，
 * 否则是外部目录。归属必须与 createChat 写入的一致，否则运行时登记的
 * home 实体在按目录访问的列表里永远缺席。
 */
export function originOfRoot(rootPath: string): SessionOrigin {
  const owner = homes.list().find((entry) => entry.valid && join(entry.path, 'sessions') === rootPath)
  return owner ? homeOrigin(owner.path) : externalOrigin(rootPath)
}

function sameOrigin(a: SessionOrigin, b: SessionOrigin): boolean {
  return scopeKeyOf(a) === scopeKeyOf(b)
}

/** 心跳的 `provider/model` 转成实体上的模型事实；拆不开或不完整的引用不记。 */
function modelOf(ref: string | null): PiSession['model'] {
  if (!ref) return null
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1) return null
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1), thinkingLevel: '' }
}

/** 一条会话的归属：按会话文件落在哪个已登记 home 的 sessions/ 下判定。 */
export function originOfSessionFile(filePath: string): SessionOrigin {
  const owner = homes.list().find((entry) => entry.valid && filePath.startsWith(`${join(entry.path, 'sessions')}/`))
  return owner ? homeOrigin(owner.path) : externalOrigin('')
}

/** 扫描结果写进注册表：只有 `discovered` 实体可以整体替换磁盘事实。 */
export function upsertDisk(origin: SessionOrigin, row: DiskRow): PiSession {
  const existing = entities.get(row.id)
  const disk: DiskFacts = {
    size: row.size,
    mtime: row.modified,
    format: row.format,
    messageCount: row.messageCount,
    firstMessage: row.firstMessage,
    createdAt: row.created,
    updatedAt: row.modified,
    projectKey: row.projectKey,
    projectName: row.projectName,
    projectDir: row.projectDir,
  }
  if (existing) {
    const before = JSON.stringify([existing.disk, existing.origin])
    // `discovered` 包括心跳先于扫描建出的占位：扫到文件就由扫描认领，归属对齐到当前作用域。
    if (existing.state === 'discovered' || existing.state === 'evicted') {
      existing.disk = disk
      setState(existing, 'discovered')
      existing.title = row.name ?? existing.title
      existing.cwd = row.cwd || existing.cwd
      existing.filePath = row.path
      existing.persistence = 'file'
      existing.seenAt = Date.now()
      // 磁盘上的文件没有归属：哪个作用域扫到它，它就归哪个作用域管。
      // 同一个 sessions 目录既能按 home 访问也能按 root 访问，不对齐的话
      // 换一种访问方式列表就是空的。
      existing.origin = origin
      if (before !== JSON.stringify([disk, origin])) bump()
      return existing
    }
    // 运行中的会话：文件是运行时输出的追加副本，只刷新大小与时间。
    existing.disk = existing.disk
      ? { ...existing.disk, size: disk.size, mtime: disk.mtime, updatedAt: Math.max(existing.disk.updatedAt, disk.updatedAt) }
      : disk
    existing.seenAt = Date.now()
    return existing
  }

  const entity: PiSession = {
    id: row.id,
    identitySource: row.format === 'pi' ? 'header' : 'derived',
    origin,
    kind: 'cli',
    parentFile: null,
    persistence: 'file',
    filePath: row.path,
    cwd: row.cwd,
    title: row.name ?? null,
    disk,
    state: 'discovered',
    stateSince: Date.now(),
    error: null,
    runtimes: [],
    model: null,
    queue: 0,
    interactions: 0,
    execution: null,
    profileRevision: 0,
    seenAt: Date.now(),
  }
  entities.set(entity.id, entity)
  bump()
  return entity
}

/** 状态字段的唯一写入口：只有这里能改 `state`，每次变化同步 `stateSince`。 */
function setState(entity: PiSession, to: SessionState): void {
  if (entity.state === to) return
  entity.state = to
  entity.stateSince = Date.now()
  bump()
}

/**
 * 状态迁移的唯一入口：按 `TRANSITIONS` 校验，非法迁移报冲突（路由层转 409）。
 *
 * 同状态重复迁移是幂等的 no-op：心跳与事件回调会反复同步同一个目标状态。
 * 实体不存在时返回 null，调用方按「还没登记」处理，不在这里凭空建实体。
 */
export function transition(
  sessionId: string,
  to: SessionState,
  opts?: { error?: { message: string; phase: 'assemble' | 'turn' } | null; instanceId?: string },
): PiSession | null {
  const entity = entities.get(sessionId)
  if (!entity) return null
  if (entity.state !== to && !TRANSITIONS[entity.state].includes(to)) {
    const actor = opts?.instanceId ? `（实例 ${opts.instanceId}）` : ''
    throw new ConflictError(`会话 ${sessionId} 不能从 ${entity.state} 迁移到 ${to}${actor}`)
  }
  setState(entity, to)
  if (opts && 'error' in opts) entity.error = opts.error ?? null
  return entity
}

/** 运行时字段的唯一写者：对话、任务都从这里同步。状态则统一走 `transition`。 */
export function syncRuntime(snapshot: RuntimeSnapshot): PiSession {
  const origin = homeOrigin(snapshot.homePath)
  let entity = entities.get(snapshot.sessionId)
  if (!entity) {
    // 新实体直接落成运行时给的目标状态：它没有前一个状态可迁移。
    entity = {
      id: snapshot.sessionId,
      identitySource: 'minted',
      origin,
      kind: snapshot.kind,
      parentFile: null,
      persistence: snapshot.filePath ? 'file' : 'memory',
      filePath: snapshot.filePath,
      cwd: snapshot.cwd,
      title: snapshot.title ?? null,
      disk: null,
      state: snapshot.toState,
      stateSince: Date.now(),
      error: snapshot.error ?? null,
      runtimes: [],
      model: snapshot.model ?? null,
      queue: snapshot.queue ?? 0,
      interactions: snapshot.interactions ?? 0,
      execution: snapshot.execution ?? null,
      profileRevision: snapshot.profileRevision ?? 0,
      seenAt: Date.now(),
    }
    entities.set(entity.id, entity)
    bump()
  } else {
    const stateChanged = entity.state !== snapshot.toState
    const changed =
      stateChanged
      || entity.error?.message !== snapshot.error?.message
      || entity.queue !== (snapshot.queue ?? 0)
      || entity.filePath !== snapshot.filePath
      || (snapshot.title != null && snapshot.title !== entity.title)
    entity.error = snapshot.error ?? null
    entity.filePath = snapshot.filePath ?? entity.filePath
    entity.persistence = entity.filePath ? 'file' : 'memory'
    entity.cwd = snapshot.cwd || entity.cwd
    entity.title = snapshot.title ?? entity.title
    entity.model = snapshot.model ?? entity.model
    entity.queue = snapshot.queue ?? 0
    entity.interactions = snapshot.interactions ?? 0
    entity.execution = snapshot.execution ?? null
    entity.profileRevision = snapshot.profileRevision ?? entity.profileRevision
    // 只有实质变化才刷 seenAt：心跳每几秒一次，每次都刷会让所有活跃会话的
    // modified 相同，列表排序退化成注册顺序，刚发消息的新会话排不到前面。
    if (changed) {
      entity.seenAt = Date.now()
      bump()
    }
    // 状态走唯一入口：非法迁移直接抛冲突，不会静默把实体写成别的样子。
    transition(entity.id, snapshot.toState, { instanceId: snapshot.instanceId })
  }

  const now = Date.now()
  const fact: RuntimeFact = {
    instanceId: snapshot.instanceId,
    origin: 'local',
    host: '',
    pid: process.pid,
    status: snapshot.toState === 'running' ? 'running' : 'idle',
    updatedAt: now,
  }
  const others = entity.runtimes.filter((item) => item.instanceId !== snapshot.instanceId)
  entity.runtimes = [fact, ...others]
  return entity
}

/** 运行时释放：有文件回落 `discovered`（下次扫描补磁盘事实），无文件直接移除。 */
export function detachRuntime(sessionId: string, instanceId: string): void {
  const entity = entities.get(sessionId)
  if (!entity) return
  entity.runtimes = entity.runtimes.filter((item) => item.instanceId !== instanceId)
  if (entity.runtimes.some((item) => item.origin === 'local')) return
  if (entity.persistence === 'memory' && !entity.filePath) {
    entities.delete(sessionId)
    bump()
    return
  }
  // 释放是运行时的最后一步，必须走完：哪怕当前状态不在迁移表里也落成 evicted。
  setState(entity, 'evicted')
  entity.queue = 0
  entity.interactions = 0
  bump()
}

/**
 * 其它进程正在用的会话：心跳里有路径与目录，占位实体要带上，
 * 否则它在清单里没有归属、没有文件，按 home 过滤时永远缺席。
 */
export interface ProcessSessionHint {
  sessionFile: string | null
  cwd: string
  /** 心跳里的模型引用 `provider/model`，只给侧栏显示用。 */
  model?: string | null
}

/**
 * 跨进程心跳：只替换 `origin: 'process'` 的那批运行态。
 *
 * 尚未登记的会话先按心跳建一条 `discovered` 实体（它是磁盘上被别的进程用着的会话，
 * 不是本进程在跑），归属按会话文件落在哪个 home 的 sessions/ 下判定。
 */
export function syncProcessRuntimes(
  facts: Array<{ sessionId: string; fact: RuntimeFact; hint?: ProcessSessionHint }>,
): void {
  const bySession = new Map<string, RuntimeFact[]>()
  for (const { sessionId, fact } of facts) {
    const list = bySession.get(sessionId) ?? []
    list.push(fact)
    bySession.set(sessionId, list)
  }
  let changed = false
  for (const entity of entities.values()) {
    if (!bySession.has(entity.id) && !entity.runtimes.some((item) => item.origin === 'process')) continue
    const local = entity.runtimes.filter((item) => item.origin === 'local')
    const next = [...local, ...(bySession.get(entity.id) ?? [])]
    if (JSON.stringify(next) === JSON.stringify(entity.runtimes)) continue
    entity.runtimes = next
    changed = true
  }
  const hints = new Map(facts.map((item) => [item.sessionId, item.hint]))
  for (const [sessionId, list] of bySession) {
    if (entities.has(sessionId)) continue
    // 其它进程的会话可能还没进注册表（还没扫到，或在 home 之外），只登记运行态与心跳给的路径。
    const hint = hints.get(sessionId)
    const filePath = hint?.sessionFile ?? null
    const entity: PiSession = {
      id: sessionId,
      identitySource: 'header',
      origin: filePath ? originOfSessionFile(filePath) : externalOrigin(''),
      kind: 'cli',
      parentFile: null,
      persistence: 'file',
      filePath,
      cwd: hint?.cwd ?? '',
      title: null,
      disk: null,
      state: 'discovered',
      stateSince: Date.now(),
      error: null,
      runtimes: list,
      model: modelOf(hint?.model),
      queue: 0,
      interactions: 0,
      execution: null,
      profileRevision: 0,
      seenAt: Date.now(),
    }
    entities.set(sessionId, entity)
    changed = true
  }
  if (changed) bump()
}

export function getEntity(sessionId: string): PiSession | null {
  return entities.get(sessionId) ?? null
}

export function removeEntity(sessionId: string): void {
  if (entities.delete(sessionId)) bump()
}

export function entityCount(): number {
  return entities.size
}

/**
 * 心跳汇总的旁路事实：心跳插件是否装在任一 home。
 *
 * 由 runtime 的心跳合流写、会话清单读：会话域不 import runtime，也不自己扫 extensions/。
 */
let heartbeatPluginDetected = false

export function noteHeartbeatSync(pluginDetected: boolean): void {
  if (heartbeatPluginDetected === pluginDetected) return
  heartbeatPluginDetected = pluginDetected
  bump()
}

export function heartbeatPluginFound(): boolean {
  return heartbeatPluginDetected
}

export interface SessionFilter {
  origin?: SessionOrigin
  state?: SessionState | 'live'
  kind?: SessionKind
  parentFile?: string
  query?: string
  since?: number
}

export function listEntities(filter: SessionFilter = {}): PiSession[] {
  const query = filter.query?.trim().toLowerCase() ?? ''
  const out: PiSession[] = []
  for (const entity of entities.values()) {
    if (filter.origin && !sameOrigin(entity.origin, filter.origin)) continue
    if (filter.kind && entity.kind !== filter.kind) continue
    if (filter.parentFile && entity.parentFile !== filter.parentFile) continue
    if (filter.state === 'live') {
      if (entity.state === 'discovered' || entity.state === 'evicted') continue
    } else if (filter.state && entity.state !== filter.state) continue
    if (query) {
      const haystack = [entity.id, entity.title ?? '', entity.cwd, entity.disk?.firstMessage ?? '']
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(query)) continue
    }
    out.push(entity)
  }
  return out.sort((a, b) => modifiedOf(b) - modifiedOf(a) || a.id.localeCompare(b.id))
}

/**
 * 活动时间：有磁盘事实就用文件修改时间，还没落盘的新会话才用注册时刻。
 * seenAt 每次扫描、每次实质变化都会刷，拿它参与排序会让整份列表在同一毫秒
 * 上并列，退化成注册顺序。
 */
export function modifiedOf(entity: PiSession): number {
  return entity.disk?.updatedAt ?? entity.seenAt
}

/**
 * 同机另一个进程正在用这条会话：两个运行时同时追同一个文件会双写，本进程只读。
 */
export function foreignRuntimeOf(entity: PiSession): RuntimeFact | null {
  return entity.runtimes.find((item) => item.origin === 'process' && item.host === LOCAL_HOST) ?? null
}

/** 能力由状态与身份派生，不单独存字段。 */
export function capabilitiesOf(entity: PiSession): PiSessionCapabilities {
  const local = entity.runtimes.some((item) => item.origin === 'local')
  const base: PiSessionCapabilities = {
    canLoad: entity.state === 'discovered' || entity.state === 'evicted' || entity.state === 'failed',
    canTurn: entity.state === 'ready' || entity.state === 'running',
    canEvict: local,
    canDelete: entity.state !== 'running' && entity.state !== 'loading',
    canContinue: true,
  }
  if (entity.identitySource === 'derived') {
    return { ...base, canLoad: false, canTurn: false, canContinue: false, reason: 'legacy_without_header' }
  }
  if (entity.origin.kind === 'external' && entity.kind === 'cli') {
    // 外部目录的会话要用某个 home 的 profile 才能运行，由调用方显式指定。
    const foreign = foreignRuntimeOf(entity) !== null
    return {
      ...base,
      canTurn: false,
      canContinue: foreign ? false : base.canLoad,
      ...(foreign ? { reason: 'runtime_elsewhere' } : {}),
    }
  }
  // 同机异进程心跳：v1 只读，跨机心跳不管（live 事实以会话文件为准）。
  if (foreignRuntimeOf(entity)) {
    return { ...base, canContinue: false, reason: 'runtime_elsewhere' }
  }
  return base
}

/** 对外投影：大字段（disk 的原始行）在这里补上派生值。 */
export function project(entity: PiSession): PiSession & { capabilities: PiSessionCapabilities } {
  return { ...entity, capabilities: capabilitiesOf(entity) }
}
