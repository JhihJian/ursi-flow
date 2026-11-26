import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname, homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

/**
 * Pi 会话心跳。
 *
 * pi 本身不维护跨进程的会话注册表：运行态只存在于进程内存里，磁盘上只有结束
 * 后也一样的 jsonl。本扩展把运行态落成每会话一个 JSON 文件，位置固定为
 *
 *   <pi home>/state/running-sessions/<sessionId>.json
 *
 * pi-web 等旁路进程按目录读取，就能看到 TUI、pi-web、SDK 起的会话。
 * 每个文件带 host 与 pid，读取方据此判断进程是否还活着；扩展自己也在每次
 * session_start 时清扫一遍同机的死进程残留。
 *
 * 生命周期：
 * - session_start 写入文件并开始每 15 秒续写 updatedAt
 * - agent_start 标 running，agent_settled 标 idle
 * - session_info_changed / model_select 更新名称与模型
 * - session_shutdown 与进程退出删除本进程写下的文件
 *
 * 心跳是旁路信息，任何读写失败都不影响会话本身。
 */

const VERSION = 1
const BEAT_MS = 15_000
/** 同机进程已消失就立即删除；跨机或无法解析时按年龄兜底。 */
const REMOTE_STALE_MS = 30 * 60_000
/** 写临时文件时进程被强杀会留下未 rename 的碎片。 */
const TMP_STALE_MS = 10 * 60_000
const HOST = hostname()

type SessionStatus = 'idle' | 'running'

interface Heartbeat {
  version: number
  host: string
  pid: number
  sessionId: string
  sessionFile: string | null
  parentSessionFile: string | null
  cwd: string
  name: string | null
  mode: string
  model: string | null
  status: SessionStatus
  startedAt: number
  updatedAt: number
}

/** 从 <home>/sessions/<project> 反推 home；自定义会话目录退回环境变量与默认值。 */
function resolveHome(sessionDir: string): string {
  const trimmed = sessionDir.replace(/[\\/]+$/, '')
  const at = trimmed.lastIndexOf(`${sep}sessions${sep}`)
  if (at > 0) return trimmed.slice(0, at)

  const bare = `${sep}sessions`
  if (trimmed.endsWith(bare) && trimmed.length > bare.length) {
    return trimmed.slice(0, -bare.length)
  }

  const env = process.env.PI_CODING_AGENT_DIR
  if (env) return env.startsWith('~') ? join(homedir(), env.slice(1)) : env
  return join(homedir(), '.pi', 'agent')
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 说明进程存在但不属于当前用户。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function parseBeat(path: string): Partial<Heartbeat> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return value && typeof value === 'object' ? (value as Partial<Heartbeat>) : null
  } catch {
    return null
  }
}

/** 清掉同机死进程、跨机过期条目和残留临时文件；正在写的文件由调用方排除。 */
function sweep(dir: string, ownFile: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }

  const now = Date.now()
  for (const name of names) {
    const path = join(dir, name)
    if (path === ownFile) continue

    let age = Number.POSITIVE_INFINITY
    try {
      age = now - statSync(path).mtimeMs
    } catch {
      continue
    }

    if (name.endsWith('.tmp')) {
      if (age > TMP_STALE_MS) rmSync(path, { force: true })
      continue
    }
    if (!name.endsWith('.json')) continue

    const beat = parseBeat(path)
    if (!beat) {
      if (age > REMOTE_STALE_MS) rmSync(path, { force: true })
      continue
    }

    const updatedAt = typeof beat.updatedAt === 'number' ? beat.updatedAt : 0
    if (beat.host === HOST && typeof beat.pid === 'number') {
      if (!isProcessAlive(beat.pid) || now - updatedAt > REMOTE_STALE_MS) {
        rmSync(path, { force: true })
      }
      continue
    }
    if (now - updatedAt > REMOTE_STALE_MS) rmSync(path, { force: true })
  }
}

function safeSessionId(raw: string): string {
  const id = raw.replace(/[^A-Za-z0-9._-]/g, '_')
  return id || 'session'
}

export default function sessionHeartbeat(pi: ExtensionAPI) {
  let dir: string | null = null
  let file: string | null = null
  let beat: Heartbeat | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let exitHook: (() => void) | null = null
  let warned = false

  function warn(message: string): void {
    if (warned || process.env.PI_SESSION_HEARTBEAT_DEBUG !== '1') return
    warned = true
    process.stderr.write(`[session-heartbeat] ${message}\n`)
  }

  function write(): void {
    if (!dir || !file || !beat) return
    const payload: Heartbeat = { ...beat, updatedAt: Date.now() }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, file)
      beat = payload
    } catch (error) {
      // 目录只读、磁盘满等情况下放弃心跳，不影响会话。
      warn(error instanceof Error ? error.message : String(error))
    }
  }

  /** 只删除本进程写下的文件：同一 session 可能已被另一个进程接管。 */
  function removeOwnFile(): void {
    if (!file) return
    const current = parseBeat(file)
    if (current?.host === HOST && current.pid === process.pid) {
      try {
        unlinkSync(file)
      } catch {
        // 已被清扫或不存在。
      }
    }
    file = null
  }

  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
    if (exitHook) {
      process.off('exit', exitHook)
      exitHook = null
    }
  }

  function setStatus(status: SessionStatus): void {
    if (!beat || beat.status === status) return
    beat = { ...beat, status }
    write()
  }

  function start(ctx: ExtensionContext): void {
    stop()

    const sessionFile = ctx.sessionManager.getSessionFile() ?? null
    const header = ctx.sessionManager.getHeader()
    const sessionId = ctx.sessionManager.getSessionId()
    const home = resolveHome(ctx.sessionManager.getSessionDir())
    dir = join(home, 'state', 'running-sessions')
    file = join(dir, `${safeSessionId(sessionId)}.json`)
    sweep(dir, file)

    const headerStarted = header?.timestamp ? Date.parse(header.timestamp) : Number.NaN
    beat = {
      version: VERSION,
      host: HOST,
      pid: process.pid,
      sessionId,
      sessionFile,
      parentSessionFile: header?.parentSession ?? null,
      cwd: ctx.cwd,
      name: ctx.sessionManager.getSessionName() ?? null,
      mode: ctx.mode,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      status: ctx.isIdle() ? 'idle' : 'running',
      startedAt: Number.isFinite(headerStarted) ? headerStarted : Date.now(),
      updatedAt: Date.now(),
    }

    write()
    timer = setInterval(write, BEAT_MS)
    timer.unref?.()

    exitHook = () => removeOwnFile()
    process.once('exit', exitHook)
  }

  pi.on('session_start', async (_event, ctx) => start(ctx))

  pi.on('session_shutdown', async () => {
    stop()
    removeOwnFile()
    beat = null
  })

  pi.on('agent_start', async (_event, ctx) => {
    if (!beat) start(ctx)
    setStatus('running')
  })

  pi.on('agent_settled', async () => setStatus('idle'))

  pi.on('session_info_changed', async (event) => {
    if (!beat) return
    beat = { ...beat, name: event.name ?? null }
    write()
  })

  pi.on('model_select', async (_event, ctx) => {
    if (!beat) return
    beat = { ...beat, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null }
    write()
  })
}
