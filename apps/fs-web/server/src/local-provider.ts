import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import type { EntryDto, WorkspaceConfig } from './types.ts'
import { gitPullOf, gitPushOf, gitStatusOf } from './git-provider.ts'

/**
 * 统一目录抽象。第一版只实现 local；SSH（无 watch 能力）与虚拟目录后续接入。
 * 所有路径参数都是相对 root 的 segments，安全检查在这里统一做。
 * 可选能力用可选方法声明（如 gitStatus?），调用前按 typeof === 'function' 判断。
 */
export interface WorkspaceProvider {
  list(workspace: WorkspaceConfig, segments: string[]): Promise<EntryDto[]>
  read(
    workspace: WorkspaceConfig,
    segments: string[],
  ): Promise<{ content: string; mtime: number; size: number }>
  write(
    workspace: WorkspaceConfig,
    segments: string[],
    content: string,
    options: { expectMtime?: number; overwrite?: boolean },
  ): Promise<{ mtime: number }>
  stat(workspace: WorkspaceConfig, segments: string[]): Promise<EntryDto>
  mkdir(workspace: WorkspaceConfig, segments: string[]): Promise<EntryDto>
  rename(workspace: WorkspaceConfig, segments: string[], newName: string): Promise<EntryDto>
  delete(workspace: WorkspaceConfig, segments: string[]): Promise<void>
  /** 只读 git 状态快照；仅 local 实现。 */
  gitStatus?(workspace: WorkspaceConfig): Promise<import('./types.ts').GitStatusDto>
  /** 推送当前分支到 upstream；仅 local 实现。 */
  gitPush?(workspace: WorkspaceConfig): Promise<{ ok: true }>
  /** 拉取并快进当前分支；仅 local 实现。 */
  gitPull?(workspace: WorkspaceConfig): Promise<{ ok: true }>
}

/** provider 层错误：code 进 ApiError，层上不碰 HTTP。 */
export class ProviderError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** 名称合法性：本版按 POSIX 单段校验，禁止路径分隔符与控制字符。 */
export function assertValidSegment(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new ProviderError('bad_request', 400, `非法名称：${JSON.stringify(name)}`)
  }
  if (name.includes('\0')) {
    throw new ProviderError('bad_request', 400, '名称包含 NUL 字节')
  }
  for (const ch of name) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x20) {
      throw new ProviderError('bad_request', 400, `名称包含控制字符：U+${cp.toString(16)}`)
    }
  }
  if (name.length > 255) {
    throw new ProviderError('bad_request', 400, '名称超过 255 字符')
  }
}

/** 逐段校验；空数组表示 root 本身。 */
export function assertValidSegments(segments: unknown): string[] {
  if (!Array.isArray(segments)) throw new ProviderError('bad_request', 400, 'path 必须是字符串数组')
  for (const segment of segments) {
    if (typeof segment !== 'string') {
      throw new ProviderError('bad_request', 400, 'path 必须是字符串数组')
    }
    assertValidSegment(segment)
  }
  return segments
}

const TEXT_LIMIT_BYTES = 2 * 1024 * 1024 // 超过不进编辑器

/**
 * 把 segments 解析为安全绝对路径：从 root 的真实路径重建，逐段不引入符号链接。
 * 目标不存在时（write/mkdir/rename 目标）回退到最近存在的祖先目录做前缀校验。
 */
async function resolveInsideRoot(root: string, segments: string[]): Promise<string> {
  let realRoot: string
  try {
    realRoot = await fs.realpath(root)
  } catch (error) {
    throw mapFsError(error, segments)
  }
  const target = path.resolve(realRoot, ...segments)
  let resolved: string
  try {
    resolved = await fs.realpath(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw mapFsError(error, segments)
    // 目标尚不存在：校验最近存在的祖先（不存在的尾段不可能含软链）。
    const parent = path.dirname(target)
    try {
      resolved = path.join(await fs.realpath(parent), path.basename(target))
    } catch (parentError) {
      throw mapFsError(parentError, segments)
    }
  }
  if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
    throw new ProviderError('path_outside_root', 403, '路径越出 workspace 根目录')
  }
  return resolved
}

function mapFsError(error: unknown, segments: string[]): never {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as NodeJS.ErrnoException | null)?.code ?? ''
  if (code === 'ENOENT') {
    throw new ProviderError('not_found', 404, `路径不存在：/${segments.join('/')}`)
  }
  if (code === 'ENOTDIR') {
    throw new ProviderError('not_dir', 400, `路径经过的不是目录：/${segments.join('/')}`)
  }
  if (code === 'EISDIR') {
    throw new ProviderError('bad_request', 400, `目标是目录：/${segments.join('/')}`)
  }
  if (code === 'EEXIST') {
    throw new ProviderError('exists', 409, `已存在同名条目：/${segments.join('/')}`)
  }
  if (code === 'EACCES' || code === 'EPERM') {
    throw new ProviderError('io', 403, `无权限访问：/${segments.join('/')}`)
  }
  throw new ProviderError('io', 500, message)
}

function entryFromStats(name: string, stats: { isDirectory(): boolean; size: number; mtimeMs: number }): EntryDto {
  return {
    name,
    type: stats.isDirectory() ? 'dir' : 'file',
    size: stats.size,
    mtime: stats.mtimeMs,
  }
}

export function createLocalProvider(): WorkspaceProvider {
  const provider = {
    async list(workspace, segments) {
      assertValidSegments(segments)
      const absolute = await resolveInsideRoot(workspace.root, segments)
      const dirents = await fs.readdir(absolute, { withFileTypes: true }).catch((error) => mapFsError(error, segments))
      const entries = await Promise.all(
        dirents.map(async (dirent) => {
          // readdir 的 dirent.type 在部分平台可能不可靠，stat 兜底；软链目标越界不隐藏，由读写时拦截。
          try {
            const stats = await fs.stat(path.join(absolute, dirent.name))
            return entryFromStats(dirent.name, stats)
          } catch {
            return { name: dirent.name, type: dirent.isDirectory() ? ('dir' as const) : ('file' as const), size: 0, mtime: 0 }
          }
        }),
      )
      return entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-Hans-CN')
      })
    },

    async read(workspace, segments) {
      assertValidSegments(segments)
      if (segments.length === 0) throw new ProviderError('bad_request', 400, 'read 需要文件路径')
      const absolute = await resolveInsideRoot(workspace.root, segments)
      const stats = await fs.stat(absolute).catch((error) => mapFsError(error, segments))
      if (!stats.isFile()) throw new ProviderError('bad_request', 400, 'read 只支持普通文件')
      if (stats.size > TEXT_LIMIT_BYTES) {
        throw new ProviderError('too_large', 413, `文件超过 2MB 编辑上限（${stats.size} 字节）`)
      }
      const buffer = await fs.readFile(absolute).catch((error) => mapFsError(error, segments))
      if (buffer.includes(0)) {
        throw new ProviderError('binary', 415, '文件含 NUL 字节，按二进制处理，不进编辑器')
      }
      return { content: buffer.toString('utf8'), mtime: stats.mtimeMs, size: stats.size }
    },

    async write(workspace, segments, content, options) {
      assertValidSegments(segments)
      if (segments.length === 0) throw new ProviderError('bad_request', 400, 'write 需要文件路径')
      const absolute = await resolveInsideRoot(workspace.root, segments)
      let currentMtime: number | null = null
      try {
        currentMtime = (await fs.stat(absolute)).mtimeMs
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw mapFsError(error, segments)
      }

      if (options.overwrite !== true) {
        // 乐观锁：文件存在且 expectMtime 不匹配即冲突；文件不存在而调用方声明了 mtime，同样视为冲突。
        if (currentMtime !== null) {
          if (options.expectMtime === undefined) {
            throw new ProviderError('conflict', 409, '文件已被外部创建，刷新后再保存')
          }
          if (options.expectMtime !== currentMtime) {
            throw new ProviderError('conflict', 409, '文件已被外部修改（mtime 不一致）')
          }
        } else if (options.expectMtime !== undefined) {
          throw new ProviderError('conflict', 409, '文件已被外部删除，刷新后再保存')
        }
      }

      // 先写同目录临时文件再 rename，避免半截文件。
      const temp = path.join(path.dirname(absolute), `.${path.basename(absolute)}.ww-tmp-${process.pid}-${Date.now()}`)
      await fs.writeFile(temp, content, 'utf8').catch((error) => mapFsError(error, segments))
      try {
        await fs.rename(temp, absolute)
      } catch (error) {
        await fs.unlink(temp).catch(() => {})
        throw mapFsError(error, segments)
      }
      const stats = await fs.stat(absolute)
      return { mtime: stats.mtimeMs }
    },

    async stat(workspace, segments) {
      assertValidSegments(segments)
      const absolute = await resolveInsideRoot(workspace.root, segments)
      const stats = await fs.stat(absolute).catch((error) => mapFsError(error, segments))
      return entryFromStats(path.basename(absolute) || workspace.id, stats)
    },

    async mkdir(workspace, segments) {
      assertValidSegments(segments)
      if (segments.length === 0) throw new ProviderError('bad_request', 400, 'mkdir 需要目录名')
      const absolute = await resolveInsideRoot(workspace.root, segments)
      await fs.mkdir(absolute).catch((error) => mapFsError(error, segments))
      const stats = await fs.stat(absolute)
      return entryFromStats(segments[segments.length - 1] ?? '', stats)
    },

    async rename(workspace, segments, newName) {
      assertValidSegments(segments)
      if (segments.length === 0) throw new ProviderError('bad_request', 400, 'rename 需要条目路径')
      assertValidSegment(newName)
      const absolute = await resolveInsideRoot(workspace.root, segments)
      const target = await resolveInsideRoot(workspace.root, [...segments.slice(0, -1), newName])
      await fs.rename(absolute, target).catch((error) => mapFsError(error, segments))
      const stats = await fs.stat(target)
      return entryFromStats(newName, stats)
    },

    async delete(workspace, segments) {
      assertValidSegments(segments)
      if (segments.length === 0) throw new ProviderError('bad_request', 400, '不能删除 workspace 根目录')
      const absolute = await resolveInsideRoot(workspace.root, segments)
      const stats = await fs.stat(absolute).catch((error) => mapFsError(error, segments))
      if (stats.isDirectory()) {
        await fs.rm(absolute, { recursive: true }).catch((error) => mapFsError(error, segments))
      } else {
        await fs.unlink(absolute).catch((error) => mapFsError(error, segments))
      }
    },

    // 可选能力：git 只读状态快照（阶段 1.5）与上游同步。SSH provider 不承诺这些能力。
    async gitStatus(workspace) {
      return gitStatusOf(workspace)
    },
    async gitPush(workspace) {
      return gitPushOf(workspace)
    },
    async gitPull(workspace) {
      return gitPullOf(workspace)
    },
  }
  return provider
}

/** 单条 workspace 记录校验与规范化；配置文件与运行时状态文件共用。 */
export function parseWorkspaceSeed(item: unknown, source: string): WorkspaceConfig {
  if (typeof item?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(item.id)) {
    throw new Error(`workspace id 非法：${JSON.stringify(item?.id)}（小写字母、数字、短横线）：${source}`)
  }
  if (item.provider !== 'local') throw new Error(`不支持的 provider：${item.provider}：${source}`)
  if (typeof item.root !== 'string' || !path.isAbsolute(item.root)) {
    throw new Error(`workspace ${item.id} 的 root 必须是绝对路径：${source}`)
  }
  return {
    id: item.id,
    label: typeof item.label === 'string' && item.label ? item.label : item.id,
    description: typeof item.description === 'string' && item.description ? item.description : undefined,
    provider: 'local',
    root: item.root,
  }
}

/** 配置加载：内置默认清单 + FS_WEB_CONFIG JSON 覆盖。 */
export function loadWorkspaceConfig(env: NodeJS.ProcessEnv): WorkspaceConfig[] {
  const file = env.FS_WEB_CONFIG
  if (!file) {
    const root = process.cwd()
    return [
      {
        id: 'default',
        label: path.basename(root) || root,
        provider: 'local',
        root,
      },
    ]
  }
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(raw)) throw new Error(`${file} 应为 workspace 数组`)
  const seen = new Set<string>()
  return raw.map((item) => {
    const config = parseWorkspaceSeed(item, file)
    if (seen.has(config.id)) throw new Error(`workspace id 重复：${config.id}`)
    seen.add(config.id)
    return config
  })
}
