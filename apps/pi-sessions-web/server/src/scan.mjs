/**
 * 会话目录扫描：把任意 sessions 根目录下的 `*.jsonl` 变成侧边栏能直接渲染的行。
 *
 * 目录布局不做假设。pi 自己写成 `<root>/<项目目录>/<时间>_<uuid>.jsonl`，但这里
 * 只要根目录下 `MAX_DEPTH` 层以内出现 `.jsonl` 就收进来，因此把根指向单个项目
 * 目录、指向 `~/.pi/agent`（含 `sessions/`）或指向随手导出的会话集合都能用。
 *
 * 冷启动不做全量解析。第一次列目录时每个文件只读头部行（默认 4KB）就给出名称、
 * 项目、时间，消息数与第一条用户消息交给后台补齐；列表响应里的 `pendingDetails`
 * 是还在等后台的文件数，客户端据此再拉一次。文件内容不变就不重读，指纹是
 * `size + mtimeMs`。
 */
import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { createInterface } from 'node:readline'

/** 根目录往下收几层。pi 的 `<root>/<项目>/<文件>` 只需要 2 层，留一层余量。 */
const MAX_DEPTH = 3
/** 文件名里的会话 id：`<时间>_<uuid>.jsonl` 与老目录里的 `<uuid>.jsonl` 都认。 */
const FILE_NAME_UUID =
  /(?:^|_)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const HEADER_FIRST_READ = 4 * 1024
const HEADER_MAX_READ = 64 * 1024
/** 单次列目录最多收这么多文件，超过就截断并标 `truncated`，避免误指到大目录时卡住。 */
const DEFAULT_MAX_FILES = 5000
const DEFAULT_POOL = 4
/**
 * 首条用户消息只留这么多字符。列表拿它当标题、搜索拿它当索引键，全文没有用处：
 * 贴过大段内容的会话首条消息能到 1MB 以上，一存一行就让列表和索引一起爆掉。
 */
const FIRST_MESSAGE_MAX = 200
/**
 * 同一个文件两次全量补明细之间的最短间隔。正在跑的会话几乎每次轮询都在变大，
 * 每次都为它重读整个文件（可能有上百 MB）会把磁盘拖着走；明细晚几十秒没有代价，
 * 而期间的大小与时间仍然实时更新。
 */
const DETAIL_THROTTLE_MS = 30_000

function parseLine(text) {
  if (!text) return null
  try {
    const row = JSON.parse(text)
    return row && typeof row === 'object' && !Array.isArray(row) ? row : null
  } catch {
    return null
  }
}

/** 一条消息的纯文本：字符串内容，或 text 块拼接。 */
function textContentOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block) =>
        block &&
        typeof block === 'object' &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join(' ')
}

/** 消息行的活动时间：优先消息自带的毫秒，其次行上的 ISO 时间。 */
function activityTimeOf(row) {
  const message = row.message
  if (!message || typeof message.role !== 'string') return undefined
  if (message.role !== 'user' && message.role !== 'assistant') return undefined
  if (typeof message.timestamp === 'number') return message.timestamp
  const time = Date.parse(row.timestamp)
  return Number.isNaN(time) ? undefined : time
}

/** 累加一行的贡献。规则与 pi 的 `buildSessionInfo()` 对齐，两边计数才一致。 */
function foldRow(totals, row) {
  if (row.type === 'session_info' && typeof row.name === 'string' && row.name.trim()) {
    totals.name = row.name.trim()
  }
  const message = row.message
  if (!message || typeof message.role !== 'string') return
  totals.messageCount += 1
  const activity = activityTimeOf(row)
  if (activity !== undefined) totals.modified = Math.max(totals.modified ?? 0, activity)
  if (!totals.firstMessage && message.role === 'user') {
    totals.firstMessage = textContentOf(message).replace(/\s+/g, ' ').trim().slice(0, FIRST_MESSAGE_MAX)
  }
}

/** 只读第一行：4KB 内找不到换行才继续读到上限。 */
async function readHeaderRow(path) {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return null
  try {
    const first = Buffer.allocUnsafe(HEADER_FIRST_READ)
    const { bytesRead } = await handle.read(first, 0, first.length, 0)
    if (bytesRead <= 0) return null
    const head = first.subarray(0, bytesRead)
    const newline = head.indexOf(0x0a)
    if (newline !== -1) {
      return parseLine(head.subarray(0, newline).toString('utf8').replace(/\r$/, ''))
    }
    const rest = Buffer.allocUnsafe(HEADER_MAX_READ - bytesRead)
    const more = await handle.read(rest, 0, rest.length, bytesRead)
    const line = Buffer.concat([head, rest.subarray(0, more.bytesRead)])
      .toString('utf8')
      .split('\n')[0]
    return parseLine(line.replace(/\r$/, ''))
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** 全量读一遍，累出消息数、首条用户消息、最后活动时间与名称。 */
async function readTotals(path) {
  const totals = { messageCount: 0, firstMessage: '', name: undefined, modified: undefined }
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const row = parseLine(line.trim())
      if (row) foldRow(totals, row)
    }
  } catch {
    // 读不动就当作空明细：这一行仍然可用，名称与时间来自头部
  } finally {
    lines.close()
    stream.destroy()
  }
  return totals
}

/**
 * 项目标识：会话头部的 `cwd` 是最可靠的真实路径，目录名是 pi 的有损编码
 * （`/` 与 `-` 都写成 `-`），不能反推，只能在缺 `cwd` 时原样显示。
 */
function projectOf(cwd, projectDir) {
  if (cwd) return { projectKey: cwd, projectName: basename(cwd) || cwd }
  const trimmed = projectDir.replace(/^-+|-+$/g, '')
  return { projectKey: projectDir, projectName: trimmed || projectDir }
}

function formatOf(header) {
  if (header?.type === 'session') return 'pi'
  if (
    (header?.type === 'user' || header?.type === 'assistant') &&
    header.message &&
    typeof header.message === 'object'
  ) {
    return 'legacy'
  }
  return 'unknown'
}

function idOf(header, path) {
  if (typeof header?.id === 'string' && header.id.trim()) return header.id.trim()
  if (typeof header?.sessionId === 'string' && header.sessionId.trim()) {
    return header.sessionId.trim()
  }
  const match = basename(path).match(FILE_NAME_UUID)
  if (match) return match[1].toLowerCase()
  return basename(path).replace(/\.jsonl$/i, '')
}

/** 头部 + 文件属性组成一行；消息数留空，`detailsPending` 为 true。 */
function rowOf({ path, size, mtimeMs }, header) {
  const projectDir = basename(dirname(path))
  const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
  const created = typeof header?.timestamp === 'string' ? Date.parse(header.timestamp) : Number.NaN
  return {
    id: idOf(header, path),
    path,
    projectDir,
    ...projectOf(cwd, projectDir),
    cwd,
    name: undefined,
    firstMessage: '',
    messageCount: 0,
    created: Number.isNaN(created) ? mtimeMs : created,
    modified: Math.round(mtimeMs),
    size,
    format: formatOf(header),
    detailsPending: true,
  }
}

/** 头部行加上全量明细，成为最终的一行。 */
function withTotals(row, totals) {
  return {
    ...row,
    name: totals.name,
    firstMessage: totals.firstMessage,
    messageCount: totals.messageCount,
    modified: totals.modified ?? row.modified,
    detailsPending: false,
  }
}

/** 根目录下（含子目录，`MAX_DEPTH` 层内）的会话文件，按路径排好便于稳定输出。 */
async function collectFiles(root, maxFiles) {
  const files = []
  let truncated = false
  const walk = async (dir, depth) => {
    if (truncated) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(path, depth + 1)
        continue
      }
      // 符号链接不跟：会话目录里偶有指向别处的链接，跟进去会绕圈。
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  await walk(root, 0)
  files.sort()
  return { files, truncated }
}

/**
 * 扫描器。缓存按绝对路径存，指纹一致就复用；`load()`/`toJSON()` 让服务把它落盘，
 * 重启后不必再读一遍已有文件。
 */
export function createScanner({
  maxFiles = DEFAULT_MAX_FILES,
  pool = DEFAULT_POOL,
  detailThrottleMs = DETAIL_THROTTLE_MS,
} = {}) {
  /** path -> { size, mtimeMs, info, detailAt? } */
  const cache = new Map()
  /** path -> { size, mtimeMs }，等后台补明细 */
  const queued = new Map()
  let active = 0
  let idleWaiters = []
  let persist = null

  const settleIdle = () => {
    if (active > 0 || queued.size > 0) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  async function describe(path, fingerprint) {
    const header = await readHeaderRow(path)
    // 只留解析结果：头部原文对后续没有任何用处，留下只会让落盘的索引变大。
    const entry = { ...fingerprint, info: rowOf({ path, ...fingerprint }, header) }
    cache.set(path, entry)
    queued.set(path, fingerprint)
    return entry
  }

  async function runDetail(path, fingerprint) {
    const totals = await readTotals(path)
    const entry = cache.get(path)
    // 读到一半文件被改写过（大小变了）：这行明细作废，下次列目录重来。
    if (!entry || entry.size !== fingerprint.size) return
    cache.set(path, { ...entry, info: withTotals(entry.info, totals), detailAt: Date.now() })
    persist?.()
  }

  async function drain() {
    while (queued.size > 0) {
      while (active < pool && queued.size > 0) {
        const [path, fingerprint] = queued.entries().next().value
        queued.delete(path)
        active += 1
        void runDetail(path, fingerprint)
          .catch(() => undefined)
          .finally(() => {
            active -= 1
            settleIdle()
          })
      }
      if (active > 0) await new Promise((resolve) => setTimeout(resolve, 20))
      else settleIdle()
    }
    settleIdle()
  }

  let draining = null
  const startDrain = () => {
    if (draining) return
    draining = drain().finally(() => {
      draining = null
    })
  }

  async function whenIdle() {
    while (active > 0 || queued.size > 0) {
      await new Promise((resolve) => idleWaiters.push(resolve))
    }
  }

  async function browse(path) {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => null)
    if (!entries) return null
    const dirs = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = join(path, entry.name)
      const inner = await readdir(child, { withFileTypes: true }).catch(() => [])
      let sessions = 0
      for (const item of inner) {
        if (item.isFile() && item.name.endsWith('.jsonl')) sessions += 1
      }
      dirs.push({ name: entry.name, path: child, sessions })
    }
    dirs.sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name))
    const parent = dirname(path)
    return { path, parent: parent === path ? null : parent, dirs }
  }

  async function find(root, id) {
    if (typeof id !== 'string' || !id.trim()) return null
    const normalized = id.trim().toLowerCase()
    const prefix = root.endsWith(sep) ? root : root + sep
    for (const entry of cache.values()) {
      if (entry.info.path.startsWith(prefix) && entry.info.id.toLowerCase() === normalized) {
        return entry.info
      }
    }
    const { files } = await collectFiles(root, maxFiles)
    const hit = files.find((path) => basename(path).toLowerCase().includes(normalized))
    if (!hit) return null
    const info = await stat(hit).catch(() => null)
    if (!info) return null
    const entry = await describe(hit, { size: info.size, mtimeMs: info.mtimeMs })
    return entry.info
  }

  return {
    /** 某个根目录下的会话行。已缓存的直接复用，未缓存的读头部并排队补明细。 */
    async list(root) {
      const { files, truncated } = await collectFiles(root, maxFiles)
      const present = new Set(files)
      const prefix = root.endsWith(sep) ? root : root + sep
      for (const path of [...cache.keys()]) {
        if (path.startsWith(prefix) && !present.has(path)) cache.delete(path)
      }

      const sessions = []
      let pendingDetails = 0
      await Promise.all(
        files.map(async (path) => {
          const info = await stat(path).catch(() => null)
          if (!info) {
            cache.delete(path)
            return
          }
          const fingerprint = { size: info.size, mtimeMs: info.mtimeMs }
          const cached = cache.get(path)
          let entry
          if (cached && cached.size === fingerprint.size && cached.mtimeMs === fingerprint.mtimeMs) {
            entry = cached
          } else if (
            cached
            && !cached.info.detailsPending
            && Date.now() - (cached.detailAt ?? 0) < detailThrottleMs
          ) {
            // 刚补过明细的活跃会话：只刷新大小与时间，明细留到下一次窗口。
            entry = {
              ...cached,
              size: fingerprint.size,
              mtimeMs: fingerprint.mtimeMs,
              info: {
                ...cached.info,
                size: fingerprint.size,
                modified: Math.max(cached.info.modified, Math.round(fingerprint.mtimeMs)),
              },
            }
            cache.set(path, entry)
          } else {
            entry = await describe(path, fingerprint)
          }
          if (entry.info.detailsPending) {
            pendingDetails += 1
            queued.set(path, fingerprint)
          }
          sessions.push(entry.info)
        }),
      )

      sessions.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path))
      if (queued.size > 0) startDrain()
      return { root, sessions, pendingDetails, truncated }
    },

    browse,
    find,
    whenIdle,

    /** 文件被删掉后丢掉它的缓存，下一次列表不再出现这一行。 */
    forget(path) {
      cache.delete(path)
      queued.delete(path)
    },

    onPersist(callback) {
      persist = callback
    },

    toJSON() {
      return [...cache.values()]
    },

    load(entries) {
      if (!Array.isArray(entries)) return
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue
        const { size, mtimeMs, info, detailAt } = entry
        if (typeof size !== 'number' || typeof mtimeMs !== 'number') continue
        if (!info || typeof info.path !== 'string' || typeof info.id !== 'string') continue
        if (typeof info.modified !== 'number' || typeof info.messageCount !== 'number') continue
        cache.set(info.path, {
          size,
          mtimeMs,
          ...(typeof detailAt === 'number' && Number.isFinite(detailAt) ? { detailAt } : {}),
          info: {
            ...info,
            firstMessage: typeof info.firstMessage === 'string'
              ? info.firstMessage.slice(0, FIRST_MESSAGE_MAX)
              : '',
            detailsPending: info.detailsPending === true,
          },
        })
      }
    },
  }
}
