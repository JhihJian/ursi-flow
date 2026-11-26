import { homeIdOf } from '../config/homes.ts'
import { EPOCH, EXTERNAL_ROOT_LIMIT, EXTERNAL_ROOT_TTL_MS } from '../config.ts'

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
  state: SessionState
  model?: { provider: string; modelId: string; thinkingLevel: string } | null
  queue?: number
  interactions?: number
  error?: { message: string; phase: 'assemble' | 'turn' } | null
  profileRevision?: number
  execution?: TaskExecution | null
  instanceId: string
}

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

function sameOrigin(a: SessionOrigin, b: SessionOrigin): boolean {
  return scopeKeyOf(a) === scopeKeyOf(b)
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
    const before = JSON.stringify(existing.disk)
    if (existing.state === 'discovered' || existing.state === 'evicted') {
      existing.disk = disk
      existing.state = 'discovered'
      existing.title = row.name ?? existing.title
      existing.cwd = row.cwd || existing.cwd
      existing.filePath = row.path
      existing.persistence = 'file'
      existing.seenAt = Date.now()
      if (before !== JSON.stringify(disk)) bump()
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

/** 运行时字段的唯一写者：对话、任务都从这里同步。 */
export function syncRuntime(snapshot: RuntimeSnapshot): PiSession {
  const origin = homeOrigin(snapshot.homePath)
  let entity = entities.get(snapshot.sessionId)
  if (!entity) {
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
      state: snapshot.state,
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
    const changed =
      entity.state !== snapshot.state
      || entity.error?.message !== snapshot.error?.message
      || entity.queue !== (snapshot.queue ?? 0)
      || entity.filePath !== snapshot.filePath
    if (entity.state !== snapshot.state) entity.stateSince = Date.now()
    entity.state = snapshot.state
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
    entity.seenAt = Date.now()
    if (changed) bump()
  }

  const now = Date.now()
  const fact: RuntimeFact = {
    instanceId: snapshot.instanceId,
    origin: 'local',
    host: '',
    pid: process.pid,
    status: snapshot.state === 'running' ? 'running' : 'idle',
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
  } else {
    entity.state = 'evicted'
    entity.stateSince = Date.now()
    entity.queue = 0
    entity.interactions = 0
  }
  bump()
}

/** 跨进程心跳：只替换 `origin: 'process'` 的那批运行态。 */
export function syncProcessRuntimes(facts: Array<{ sessionId: string; fact: RuntimeFact }>): void {
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
  for (const [sessionId, list] of bySession) {
    if (entities.has(sessionId)) continue
    // 其它进程的会话可能还没进注册表（文件在别的地方或刚创建），只登记运行态。
    const entity: PiSession = {
      id: sessionId,
      identitySource: 'header',
      origin: externalOrigin(''),
      kind: 'cli',
      parentFile: null,
      persistence: 'file',
      filePath: null,
      cwd: '',
      title: null,
      disk: null,
      state: 'running',
      stateSince: Date.now(),
      error: null,
      runtimes: list,
      model: null,
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

export function findByPath(filePath: string): PiSession | null {
  for (const entity of entities.values()) if (entity.filePath === filePath) return entity
  return null
}

export function removeEntity(sessionId: string): void {
  if (entities.delete(sessionId)) bump()
}

export function entityCount(): number {
  return entities.size
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

export function modifiedOf(entity: PiSession): number {
  return Math.max(entity.disk?.updatedAt ?? 0, entity.seenAt)
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
    return { ...base, canTurn: false, canContinue: base.canLoad }
  }
  return base
}

/** 对外投影：大字段（disk 的原始行）在这里补上派生值。 */
export function project(entity: PiSession): PiSession & { capabilities: PiSessionCapabilities } {
  return { ...entity, capabilities: capabilitiesOf(entity) }
}
