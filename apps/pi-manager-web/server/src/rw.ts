import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { statSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 配置文件的统一写入原语：乐观锁 + 原子写 + .bak 备份。
 *
 * - 读取方随内容拿到 revision（mtimeMs + size 编码）；写入方必须回传同一 revision，
 *   不匹配返回 409 语义的 ConflictError，避免覆盖 pi CLI 或另一处的并发修改。
 * - 写入成功前把原文件复制为 <name>.bak-manager（避开 pi 自己的 .bak_* 系列）。
 * - 临时文件与目标同目录（保证 rename 原子性），写入模式 0600：这些文件
 *   普遍含凭据，pi 自身也按私有文件对待 auth.json。
 */

export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
  }
}

export interface FileSnapshot<T> {
  data: T
  /** mtimeMs.size 编码，写回时原样带上。 */
  revision: string
  bytes: number
}

async function currentRevision(file: string): Promise<string> {
  const info = await stat(file)
  return `${Math.round(info.mtimeMs)}.${info.size}`
}

function currentRevisionSync(file: string): string {
  const info = statSync(file)
  return `${Math.round(info.mtimeMs)}.${info.size}`
}

export async function readSnapshot<T>(
  file: string,
  parse: (text: string) => T,
): Promise<FileSnapshot<T>> {
  const text = await readFile(file, 'utf8')
  return {
    data: parse(text),
    revision: await currentRevision(file),
    bytes: Buffer.byteLength(text),
  }
}

export function readSnapshotSync<T>(
  file: string,
  parse: (text: string) => T,
): FileSnapshot<T> {
  const text = readFileSync(file, 'utf8')
  return {
    data: parse(text),
    revision: currentRevisionSync(file),
    bytes: Buffer.byteLength(text),
  }
}

export async function writeSnapshot(
  file: string,
  expectedRevision: string | undefined,
  render: () => string,
): Promise<void> {
  if (expectedRevision !== undefined) {
    let current: string
    try {
      current = await currentRevision(file)
    } catch {
      current = ''
    }
    if (current !== expectedRevision) {
      throw new ConflictError(
        '文件已被其他进程修改，请刷新后重试（读取到的快照已过期）',
      )
    }
  }
  const dir = dirname(file)
  const tmp = join(dir, `.${basename(file)}.manager-tmp`)
  const text = render()
  await writeFile(tmp, text, { mode: 0o600 })
  try {
    const existing = await stat(file)
    if (existing.isFile()) {
      await copyFile(file, join(dir, `${basename(file)}.bak-manager`))
    }
  } catch {
    // 目标不存在（首次创建）时没有可备份的内容。
  }
  await rename(tmp, file)
}

function basename(file: string): string {
  const idx = file.lastIndexOf('/')
  return idx >= 0 ? file.slice(idx + 1) : file
}
