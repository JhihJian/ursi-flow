import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

/**
 * 跨进程会话运行态：读心跳扩展写在 home 里的文件。
 *
 * 约定见 extension/README.md：每个活会话一个
 * `<home>/state/running-sessions/<sessionId>.json`。本模块只读目录，不启动
 * 会话、不改文件。心跳超过 60 秒没续写视为失联；同机条目再用 pid 判一次活，
 * 进程已经退出时不必等超时。
 */

export const HEARTBEAT_STALE_MS = 60_000

const HOST = hostname()

export interface LiveSession {
  sessionId: string
  sessionFile: string | null
  /** subagent 子会话指向父会话文件。 */
  parentSessionFile: string | null
  cwd: string
  name: string | null
  mode: string
  model: string | null
  status: 'running' | 'idle'
  startedAt: number
  updatedAt: number
  host: string
  pid: number
  /** 心跳来自本机时为 true，跨机条目只能按 updatedAt 判活。 */
  sameHost: boolean
}

export interface LiveSessionsListing {
  sessions: LiveSession[]
  heartbeatDir: string
  /** extensions/ 下是否检测到心跳扩展（安装提示用）。 */
  pluginDetected: boolean
  /** 心跳已超时或进程已退出的条目数。 */
  stale: number
  now: number
  warnings: string[]
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function detectPlugin(home: string): boolean {
  const base = join(home, 'extensions', 'pi-session-heartbeat')
  return [
    `${base}.ts`,
    `${base}.js`,
    join(base, 'index.ts'),
    join(base, 'index.js'),
  ].some((path) => existsSync(path))
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function asTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 只接受心跳扩展写出的形状；坏文件计入 stale 警告，不阻塞其余条目。 */
function parseBeat(path: string, text: string): LiveSession {
  const raw = JSON.parse(text) as Record<string, unknown>
  const sessionId = asString(raw.sessionId)
  const updatedAt = asTime(raw.updatedAt)
  if (!sessionId || updatedAt === null) {
    throw new Error(`${path} 缺少 sessionId 或 updatedAt`)
  }
  const status = raw.status === 'running' ? 'running' : 'idle'
  const host = asString(raw.host) ?? ''
  const pid = typeof raw.pid === 'number' && Number.isFinite(raw.pid) ? raw.pid : 0
  return {
    sessionId,
    sessionFile: asString(raw.sessionFile),
    parentSessionFile: asString(raw.parentSessionFile),
    cwd: asString(raw.cwd) ?? '',
    name: asString(raw.name),
    mode: asString(raw.mode) ?? 'unknown',
    model: asString(raw.model),
    status,
    startedAt: asTime(raw.startedAt) ?? updatedAt,
    updatedAt,
    host,
    pid,
    sameHost: host === HOST,
  }
}

export function readLiveSessions(home: string): LiveSessionsListing {
  return readHomes([home])[0]
}

/**
 * 汇总多份 home 的心跳：会话模块只认会话文件的绝对路径，不需要知道 home 的概念。
 * 同一个 sessionId 在多份 home 里同时出现时保留第一条（会话文件路径本来就不同）。
 */
export function readLiveSessionsAllHomes(paths: string[]): LiveSessionsListing {
  const listings = readHomes(paths)
  const seen = new Set<string>()
  const sessions: LiveSession[] = []
  const warnings: string[] = []
  let stale = 0
  let pluginDetected = false
  for (const listing of listings) {
    stale += listing.stale
    pluginDetected = pluginDetected || listing.pluginDetected
    if (warnings.length < 20) warnings.push(...listing.warnings.slice(0, 20 - warnings.length))
    for (const session of listing.sessions) {
      if (seen.has(session.sessionId)) continue
      seen.add(session.sessionId)
      sessions.push(session)
    }
  }
  sessions.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'running' ? -1 : 1
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
    return b.startedAt - a.startedAt
  })
  return {
    sessions,
    heartbeatDir: listings.length === 1 ? listings[0].heartbeatDir : paths.map((p) => join(p, 'state', 'running-sessions')).join(', '),
    pluginDetected,
    stale,
    now: Date.now(),
    warnings,
  }
}

function readHomes(paths: string[]): LiveSessionsListing[] {
  return paths.map((home) => readOneHome(home))
}

function readOneHome(home: string): LiveSessionsListing {
  const heartbeatDir = join(home, 'state', 'running-sessions')
  const pluginDetected = detectPlugin(home)
  const warnings: string[] = []
  const sessions: LiveSession[] = []
  let stale = 0

  let names: string[]
  try {
    names = readdirSync(heartbeatDir)
  } catch (error) {
    // 目录不存在等于还没收到过心跳，不是错误。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`读取心跳目录失败：${(error as Error).message}`)
    }
    return { sessions, heartbeatDir, pluginDetected, stale, now: Date.now(), warnings }
  }

  const now = Date.now()
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    const path = join(heartbeatDir, name)
    let beat: LiveSession
    try {
      beat = parseBeat(path, readFileSync(path, 'utf8'))
    } catch (error) {
      stale += 1
      if (warnings.length < 20) {
        warnings.push(`忽略无法解析的心跳：${(error as Error).message}`)
      }
      continue
    }

    const expired = now - beat.updatedAt > HEARTBEAT_STALE_MS
    const dead = beat.sameHost && !isProcessAlive(beat.pid)
    if (expired || dead) {
      stale += 1
      continue
    }
    sessions.push(beat)
  }

  sessions.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'running' ? -1 : 1
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
    return b.startedAt - a.startedAt
  })

  return { sessions, heartbeatDir, pluginDetected, stale, now, warnings }
}
