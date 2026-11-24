import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// 两种命名都出现过：`<时间>_<uuid>.jsonl` 与老目录里的 `<uuid>.jsonl`。
const FILE_NAME = /(?:^|_)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const MAX_DEPTH = 3

/**
 * 目录名是 Pi 对 cwd 的有损编码（`/` 与 `-` 都写成 `-`），不能反推真实路径。
 * 这里只保留原始目录名，真实 cwd 由会话头部的 `cwd` 字段提供。
 */
export function projectDirOf(path) {
  return path.split('/').slice(-2, -1)[0] ?? ''
}

/**
 * 只按文件名建索引：不读文件内容，一次目录遍历足够快。
 * 命中多份时取 mtime 最新的，其余作为候选返回。
 */
export function createLocator({ roots, ttlMs = 30_000 }) {
  let index = null
  let builtAt = 0
  let building = null

  async function scan(directory, depth, found) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await scan(path, depth + 1, found)
        continue
      }
      if (!entry.isFile()) continue
      const match = entry.name.match(FILE_NAME)
      if (!match) continue
      let info
      try {
        info = await stat(path)
      } catch {
        continue
      }
      const id = match[1].toLowerCase()
      const record = { path, size: info.size, mtime: info.mtimeMs }
      found.set(id, [...(found.get(id) ?? []), record])
    }
  }

  async function rebuild() {
    const found = new Map()
    for (const root of roots) await scan(root, 0, found)
    const resolved = new Map()
    for (const [id, records] of found) {
      records.sort((a, b) => b.mtime - a.mtime)
      const [best, ...rest] = records
      resolved.set(id, {
        id,
        ...best,
        projectDir: projectDirOf(best.path),
        candidates: rest.map((item) => item.path),
      })
    }
    index = resolved
    builtAt = Date.now()
  }

  async function ensureIndex() {
    if (index && Date.now() - builtAt < ttlMs) return
    building ??= rebuild().finally(() => {
      building = null
    })
    await building
  }

  return {
    async find(id) {
      const normalized = String(id ?? '').toLowerCase()
      if (!SESSION_ID.test(normalized)) return null
      await ensureIndex()
      const hit = index.get(normalized)
      if (!hit) return null
      return { ...hit, path: hit.path }
    },
    async size() {
      await ensureIndex()
      return index.size
    },
  }
}
