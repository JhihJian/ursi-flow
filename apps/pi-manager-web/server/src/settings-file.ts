import { join } from 'node:path'
import { openSync, closeSync, readFileSync, writeFileSync, fstatSync, existsSync, renameSync } from 'node:fs'
import { ConflictError, readSnapshotSync, writeSnapshot, type FileSnapshot } from './rw.ts'
import { parseJsonc } from './jsonc.ts'

/**
 * settings.json 的锁式读改写。
 *
 * pi 的全局设置文件（默认 defaultModel、defaultThinkingLevel、defaultTools、
 * codemode、packages 插件条目等）。管理台只动认识的 key：
 * 读出完整 JSON、改目标 key、整体写回；其他 key 的字节保持 JSON.parse 的
 * 键序不变（JS 对象保序），不新增也不删除未知字段。
 */

export type SettingsData = Record<string, unknown>

export interface SettingsSnapshot extends FileSnapshot<SettingsData> {
  path: string
}

export function settingsPath(home: string): string {
  return join(home, 'settings.json')
}

export function readSettings(home: string): SettingsSnapshot {
  const path = settingsPath(home)
  const snap = readSnapshotSync<SettingsData>(path, (text) => {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings.json 的顶层必须是对象')
    }
    return parsed as SettingsData
  })
  return { ...snap, path }
}

/** 读-改-写一把锁：mutator 返回 false 表示无变化，不写入。 */
export function mutateSettings(
  home: string,
  expectedRevision: string,
  mutator: (settings: SettingsData) => boolean,
): { changed: boolean; revision: string } {
  const snap = readSettings(home)
  if (snap.revision !== expectedRevision) {
    throw new ConflictError('settings.json 已被其他进程修改，请刷新后重试')
  }
  const changed = mutator(snap.data)
  if (!changed) return { changed: false, revision: snap.revision }
  const nextRevision = writeSettingsSync(home, snap.data)
  return { changed: true, revision: nextRevision }
}

/** 同步写（调用方已持有"读时快照"这一乐观锁），返回新 revision。 */
function writeSettingsSync(home: string, data: SettingsData): string {
  const path = settingsPath(home)
  const text = `${JSON.stringify(data, null, 2)}\n`
  writeAtomicWithBackup(path, text)
  const fd = openSync(path, 'r')
  try {
    const info = fstatSync(fd)
    return `${Math.round(info.mtimeMs)}.${info.size}`
  } finally {
    closeSync(fd)
  }
}

export async function writeSettings(
  home: string,
  expectedRevision: string,
  data: SettingsData,
): Promise<string> {
  await writeSnapshot(settingsPath(home), expectedRevision, () => `${JSON.stringify(data, null, 2)}\n`)
  const fresh = readSettings(home)
  return fresh.revision
}

function writeAtomicWithBackup(path: string, text: string): void {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const name = path.slice(path.lastIndexOf('/') + 1)
  const tmp = join(dir, `.${name}.manager-tmp`)
  if (existsSync(path)) {
    const original = readFileSync(path)
    writeFileSyncAtomic(join(dir, `${name}.bak-manager`), original)
  }
  writeFileSyncAtomic(tmp, Buffer.from(text, 'utf8'), 0o600)
  renameSync(tmp, path)
}

function writeFileSyncAtomic(path: string, data: Buffer, mode = 0o644): void {
  const fd = openSync(path, 'w', mode)
  try {
    writeFileSync(fd, data)
  } finally {
    closeSync(fd)
  }
}
