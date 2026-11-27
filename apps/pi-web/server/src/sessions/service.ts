import { createReadStream, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createGzip } from 'node:zlib'
import { dirname, join } from 'node:path'
import { createScanner } from './scan.ts'
import { createTransformer } from './canonicalize.ts'
import { createPrefs } from './prefs.ts'
import { deleteSessionFile } from './delete.ts'
import { localPathOf } from '../shared/locate.ts'
import {
  getEntity,
  listEntities,
  removeEntity,
  upsertDisk,
  type DiskRow,
  type PiSession,
  type SessionOrigin,
} from './registry.ts'
import { statePaths } from '../state.ts'
import { MAX_TEXT_BYTES, SCAN_MAX_FILES } from '../config.ts'
import { HomeError } from '../shared/pi-home.ts'

/**
 * 会话域服务：扫描、索引、轨迹文本、删除与偏好。
 *
 * 扫描结果一律写进 registry，接口只读注册表里的实体；不再各自维护一份列表。
 */

const PERSIST_DELAY_MS = 5000

export interface SessionService {
  scanner: ReturnType<typeof createScanner>
  prefs: ReturnType<typeof createPrefs>
  resolveRoot(input: unknown): Promise<string>
  list(origin: SessionOrigin): Promise<{ sessions: PiSession[]; pendingDetails: number; truncated: boolean }>
  forget(session: PiSession): void
  remove(session: PiSession, root: string): Promise<string[]>
  streamText(session: PiSession, res: import('node:http').ServerResponse, acceptEncoding: string): Promise<void>
  flush(): void
}

function createPersister(scanner: ReturnType<typeof createScanner>) {
  const file = statePaths().index
  let timer: NodeJS.Timeout | null = null
  let writing: Promise<void> | null = null

  const write = (): Promise<void> => {
    timer = null
    // 单飞异步写：条目上万时同步写 JSON 会卡住事件循环，正好噎住正在流的对话。
    writing = (writing ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const { writeFile, rename } = await import('node:fs/promises')
        const temporary = `${file}.tmp`
        try {
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
          await writeFile(temporary, JSON.stringify({ version: 1, entries: scanner.toJSON() }), { mode: 0o600 })
          await rename(temporary, file)
        } catch {
          // 落盘只是加速：写不进去下次重启照样能扫出来
        }
      })
    return writing
  }

  return {
    schedule(): void {
      if (timer) return
      timer = setTimeout(() => void write(), PERSIST_DELAY_MS)
      timer.unref?.()
    },
    async load(): Promise<void> {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; entries?: unknown }
        if (parsed?.version === 1 && Array.isArray(parsed.entries)) scanner.load(parsed.entries)
      } catch {
        // 没有索引或索引损坏都从空开始
      }
    },
    flush(): void {
      if (!timer) return
      clearTimeout(timer)
      void write()
    },
  }
}

export async function createSessionService(): Promise<SessionService> {
  const scanner = createScanner({ maxFiles: SCAN_MAX_FILES })
  const persister = createPersister(scanner)
  await persister.load()
  scanner.onPersist(() => persister.schedule())

  const prefs = createPrefs({ file: statePaths().prefs })
  await prefs.load()

  async function resolveRoot(input: unknown): Promise<string> {
    const expanded = localPathOf(typeof input === 'string' ? input : '', 'invalid_root')
    const info = await stat(expanded).catch(() => null)
    if (!info) throw new HomeError(`目录不存在：${expanded}`, 400, 'invalid_root')
    if (!info.isDirectory()) throw new HomeError(`不是目录：${expanded}`, 400, 'invalid_root')
    return expanded
  }

  function rootOf(origin: SessionOrigin): string {
    return origin.kind === 'home' ? join(origin.homePath, 'sessions') : origin.rootPath
  }

  return {
    scanner,
    prefs,
    resolveRoot,

    /** 扫一个作用域并把磁盘事实写进注册表，返回该作用域的实体。 */
    async list(origin) {
      const root = rootOf(origin)
      const listing = await scanner.list(root)
      for (const row of listing.sessions as DiskRow[]) upsertDisk(origin, row)
      // 该作用域里内存态会话（尚未落文件）也要出现在列表里。
      return {
        sessions: listEntities({ origin }),
        pendingDetails: listing.pendingDetails,
        truncated: listing.truncated,
      }
    },

    forget(session) {
      if (session.filePath) scanner.forget(session.filePath)
      persister.schedule()
    },

    async remove(session, root) {
      if (!session.filePath) throw new HomeError('会话还没有落盘文件', 409, 'session_memory_only')
      const result = (await deleteSessionFile({ path: session.filePath, root })) as {
        removed?: string[]
        error?: [number, string]
      }
      if (result.error) throw new HomeError(result.error[1], result.error[0], 'delete_failed')
      scanner.forget(session.filePath)
      persister.schedule()
      removeEntity(session.id)
      return result.removed ?? []
    },

    async streamText(session, res, acceptEncoding) {
      if (!session.filePath) throw new HomeError('会话还没有落盘文件', 409, 'session_memory_only')
      const size = (await stat(session.filePath).catch(() => null))?.size ?? 0
      if (size > MAX_TEXT_BYTES) {
        throw new HomeError(
          `会话 ${Math.round(size / 1024 / 1024)}MB，超过 ${Math.round(MAX_TEXT_BYTES / 1024 / 1024)}MB 上限`,
          413,
          'session_too_large',
        )
      }
      const transformer = createTransformer({
        sessionId: session.id,
        project: session.cwd || null,
        timestamp: new Date(session.disk?.createdAt ?? Date.now()).toISOString(),
      })
      const gzip = /\bgzip\b/.test(acceptEncoding)
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Session-Format': session.disk?.format ?? 'unknown',
        ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
      })
      const target = gzip ? createGzip() : res
      if (gzip) target.pipe(res)
      const lines = createInterface({
        input: createReadStream(session.filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      })
      try {
        for await (const line of lines) {
          const chunk = transformer.transform(line)
          if (chunk.length === 0) continue
          if (!target.write(`${chunk.join('\n')}\n`)) {
            await new Promise((done) => target.once('drain', done))
          }
        }
        target.end()
      } catch (error) {
        target.destroy(error as Error)
      }
    },

    flush() {
      persister.flush()
    },
  }
}

export { getEntity }
