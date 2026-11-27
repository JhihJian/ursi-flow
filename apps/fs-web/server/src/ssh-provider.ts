import { execFile } from 'node:child_process'
import { build, parentOf, parse, type Location } from '@ursi/location'
import type { EntryDto, WorkspaceConfig } from './types.ts'
import { assertValidSegment, assertValidSegments, ProviderError, type WorkspaceProvider } from './local-provider.ts'

/**
 * 远程目录 provider：把 fs-web 的文件能力延伸到 ssh 设备上的目录。
 *
 * 每个操作恰好一次 `ssh <args> <远端脚本>` 调用，参数来自 ssh-web 的
 * `GET /connections/by-name/{name}/ssh-args`，fs-web 自己不存连接信息。
 * 远端只用 POSIX 与 coreutils（realpath、stat、base64、find），不依赖 python。
 *
 * 越界防护与本机 provider 对等：每次先 `realpath` 再比对 root 前缀，
 * 符号链接指向 root 之外就被拒绝。路径经单引号转义后进入远端 shell。
 *
 * 不实现 git：远程 git 操作返回 501。
 */

const TEXT_LIMIT_BYTES = 2 * 1024 * 1024
const OP_TIMEOUT_MS = 30_000

export interface SshProviderOptions {
  /** ssh-web 的 API 基址，服务端路由是 `/api`，如 `http://127.0.0.1:8091/api`。 */
  api: string
  /** 设备 → ssh 参数的缓存；连接表改动后由 sshWebApi 侧重启生效。 */
  fetchArgs?: (device: string) => Promise<string[]>
}

/** 远端 shell 单引号字面量：内部单引号用 `'\''` 拼接。 */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 设备名 → 调用 ssh 的参数（不含首词 ssh）。 */
async function fetchSshArgs(api: string, device: string): Promise<string[]> {
  const url = `${api.replace(/\/+$/, '')}/connections/by-name/${encodeURIComponent(device)}/ssh-args`
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  } catch (error) {
    throw new ProviderError('ssh_unavailable', 503, `连不上 ssh-web（${api}）：${error instanceof Error ? error.message : String(error)}`)
  }
  if (res.status === 404) {
    throw new ProviderError('device_not_found', 404, `ssh-web 里没有名为 ${device} 的连接`)
  }
  if (!res.ok) {
    throw new ProviderError('ssh_unavailable', 503, `ssh-web 返回 ${res.status}：${await res.text()}`)
  }
  const body = (await res.json()) as { args?: unknown }
  if (!Array.isArray(body.args) || !body.args.every((item) => typeof item === 'string')) {
    throw new ProviderError('ssh_unavailable', 503, `ssh-web 返回的 args 非法：${JSON.stringify(body)}`)
  }
  return body.args
}

/** 在远端执行一段脚本，返回 stdout；非零退出码带 stderr 报错。 */
function execRemote(sshArgs: string[], script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      [
        ...sshArgs,
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'StrictHostKeyChecking=accept-new',
        // 远端登录 banner 走 stderr，会把「路径不存在」的真实原因挤掉；ERROR 级别只留 ssh 自己的错误。
        '-o',
        'LogLevel=ERROR',
        '--',
        script,
      ],
      {
        timeout: OP_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        killSignal: 'SIGKILL',
        env: { ...process.env, LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOTFOUND' || (error as NodeJS.ErrnoException).killed) {
            return reject(new ProviderError('ssh_unavailable', 503, `ssh 执行失败：${error.message}`))
          }
          // stderr 是远端或 ssh 自己的诊断；没有 stderr 时只报退出码，不回显整段脚本。
          const exit = typeof error.code === 'number' ? error.code : '?'
          return reject(
            new ProviderError(
              'ssh_unavailable',
              503,
              `远端命令失败（exit ${exit}）：${stderr.trim().split('\n')[0] || '无错误输出'}`,
            ),
          )
        }
        resolve(stdout)
      },
    )
  })
}

export function createSshProvider(options: SshProviderOptions): WorkspaceProvider {
  const argsOf = (device: string) => (options.fetchArgs ?? ((d: string) => fetchSshArgs(options.api, d)))(device)

  /** 位置 → (ssh 参数, 设备内绝对路径)。 */
  async function resolve(target: Location): Promise<{ sshArgs: string[]; path: string }> {
    if (target.scheme !== 'ssh' || !target.device) {
      throw new ProviderError('bad_request', 400, `ssh provider 不处理 ${target.scheme} 位置：${target.uri}`)
    }
    return { sshArgs: await argsOf(target.device), path: target.path }
  }

  /** 远端 realpath；不存在（exit 3）与失效软链都抛 not_found，其它失败原样上报。 */
  async function remoteRealpath(sshArgs: string[], target: string): Promise<string> {
    const out = await execRemote(
      sshArgs,
      `p=${quote(target)}; if [ -e "$p" ]; then realpath -- "$p"; elif [ -L "$p" ]; then echo "__BROKEN__"; else exit 3; fi`,
    ).catch((error) => mapRemoteError(error, []))
    const real = out.trim()
    if (real === '__BROKEN__' || !real.startsWith('/')) {
      throw new ProviderError('not_found', 404, `路径不存在或符号链接已失效：${target}`)
    }
    return real
  }

  /**
   * 把 segments 解析为安全绝对路径：从 root 的真实路径重建，逐段不引入符号链接。
   * 目标不存在时回退到最近存在的祖先做前缀校验。与本机 provider 的 resolveInsideRoot 对等。
   */
  async function resolveInsideRoot(
    sshArgs: string[],
    root: string,
    segments: string[],
  ): Promise<string> {
    const realRoot = await remoteRealpath(sshArgs, root)
    const target = joinRemote(realRoot, segments)
    const out = await execRemote(
      sshArgs,
      `t=${quote(target)}
if [ -e "$t" ]; then r=$(realpath -- "$t")
elif [ -L "$t" ]; then echo "__BROKEN__"; exit 0
else
  # 目标尚不存在：校验最近存在的祖先
  d=$(dirname -- "$t"); b=$(basename -- "$t")
  if [ -e "$d" ]; then r="$(realpath -- "$d")/$b"; else exit 3; fi
fi
printf '%s' "$r"`,
    )
    if (out === '__BROKEN__') throw new ProviderError('not_found', 404, `符号链接已失效：/${segments.join('/')}`)
    const resolved = out
    if (resolved !== realRoot && !resolved.startsWith(realRoot + '/')) {
      throw new ProviderError('path_outside_root', 403, '路径越出 workspace 根目录')
    }
    return resolved
  }

  function joinRemote(root: string, segments: string[]): string {
    if (segments.length === 0) return root
    return root.replace(/\/+$/, '') + '/' + segments.join('/')
  }

  /** 远端 stat 的类型与元信息：`type|size|mtime`。 */
  async function remoteStat(sshArgs: string[], target: string, segments: string[]): Promise<EntryDto & { absolute: string }> {
    const out = await execRemote(
      sshArgs,
      `p=${quote(target)}
if [ -L "$p" ] && [ ! -e "$p" ]; then exit 40; fi
if [ ! -e "$p" ]; then exit 44; fi
if [ -d "$p" ]; then t=dir; s=0; else t=file; s=$(stat -c %s -- "$p"); fi
m=$(stat -c %Y -- "$p")
printf '%s|%s|%s' "$t" "$s" "$m"`,
    ).catch((error) => mapRemoteError(error, segments))
    const [type, size, mtime] = out.trim().split('|')
    return {
      name: segments[segments.length - 1] ?? '',
      type: type as 'dir' | 'file',
      size: Number(size),
      mtime: Number(mtime) * 1000,
      absolute: target,
    }
  }

  function mapRemoteError(error: unknown, segments: string[]): never {
    if (!(error instanceof ProviderError)) throw error
    const message = error.message
    const exit = /exit (\d+)/.exec(message)?.[1]
    const shown = segments.length > 0 ? `：/${segments.join('/')}` : ''
    if (exit === '44' || exit === '3') throw new ProviderError('not_found', 404, `路径不存在${shown}`)
    if (exit === '40') throw new ProviderError('not_found', 404, `符号链接已失效：${shown}`)
    if (/not a directory|No such file/i.test(message)) throw new ProviderError('not_dir', 400, `路径经过的不是目录：${shown}`)
    if (/Permission denied|denied/i.test(message)) throw new ProviderError('io', 403, `无权限访问：${shown}`)
    if (/File exists/i.test(message)) throw new ProviderError('exists', 409, `已存在同名条目：${shown}`)
    // 255 是 ssh 自己的退出码：连不上、认证失败、超时。远端脚本没跑到，不是目录的 IO 问题。
    if (exit === '255') throw new ProviderError('ssh_unavailable', 503, `ssh 连接失败：${message.replace(/^远端命令失败（exit 255）：/, '')}`)
    throw new ProviderError('io', 500, message)
  }

  const provider: WorkspaceProvider = {
    async realize(uri) {
      const target = parse(uri)
      const { sshArgs, path } = await resolve(target)
      const real = await remoteRealpath(sshArgs, path)
      const out = await execRemote(sshArgs, `if [ -d ${quote(real)} ]; then echo dir; else echo file; fi`)
      if (out.trim() !== 'dir') throw new ProviderError('bad_request', 400, `不是目录：ssh://${target.device}${real}`)
      return build('ssh', target.device, real)
    },

    async browse(uri) {
      const location = await provider.realize(uri)
      const { sshArgs } = await resolve(location)
      const out = await execRemote(
        sshArgs,
        `cd ${quote(location.path)} 2>/dev/null || exit 3
# 空目录下通配符不展开会留下字面量，用 -e 过滤；dotglob 把隐藏目录带进来。
shopt -s nullglob dotglob
for f in *; do
  [ -d "$f" ] && printf '%s\\n' "$f"
done
# 循环最后一个条目若不是目录，短路会把退出码留成 1；脚本整体必须以成功结束。
exit 0`,
      ).catch((error) => mapRemoteError(error, []))
      const names = out.split('\n').filter(Boolean)
      return {
        location,
        parent: parentOf(location),
        entries: [...new Set(names)].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).map((name) => ({ name })),
      }
    },

    async list(workspace, segments) {
      assertValidSegments(segments)
      const { sshArgs } = await resolve(parse(workspace.root))
      const absolute = await resolveInsideRoot(sshArgs, parse(workspace.root).path, segments)
      const out = await execRemote(
        sshArgs,
        `cd ${quote(absolute)} 2>/dev/null || exit 3
# 空目录下通配符不展开会留下字面量；nullglob 让它消失，dotglob 把隐藏条目带进来。
shopt -s nullglob dotglob
for f in *; do
  if [ -L "$f" ] && [ ! -e "$f" ]; then printf 'file|0|0|%s\\n' "$f"; continue; fi
  if [ -d "$f" ]; then printf 'dir|0|%s|%s\\n' "$(stat -c %Y -- "$f")" "$f"
  else printf 'file|%s|%s|%s\\n' "$(stat -c %s -- "$f")" "$(stat -c %Y -- "$f")" "$f"; fi
done
exit 0`,
      ).catch((error) => mapRemoteError(error, segments))
      const entries = out.split('\n').filter(Boolean).map((line) => {
        const [type, size, mtime, ...rest] = line.split('|')
        return { name: rest.join('|'), type: type as 'dir' | 'file', size: Number(size), mtime: Number(mtime) * 1000 }
      })
      return entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-Hans-CN')
      })
    },

    async read(workspace, segments) {
      assertValidSegments(segments)
      if (segments.length === 0) throw new ProviderError('bad_request', 400, 'read 需要文件路径')
      const { sshArgs } = await resolve(parse(workspace.root))
      const absolute = await resolveInsideRoot(sshArgs, parse(workspace.root).path, segments)
      const info = await remoteStat(sshArgs, absolute, segments)
      if (info.type !== 'file') throw new ProviderError('bad_request', 400, 'read 只支持普通文件')
      if (info.size > TEXT_LIMIT_BYTES) {
        throw new ProviderError('too_large', 413, `文件超过 2MB 编辑上限（${info.size} 字节）`)
      }
      // base64 传输：stdout 是管道，避免远端 locale 或 CRLF 改写内容。
      const encoded = await execRemote(sshArgs, `base64 --wrap=0 -- ${quote(absolute)}`)
      const buffer = Buffer.from(encoded.trim(), 'base64')
      if (buffer.includes(0)) {
        throw new ProviderError('binary', 415, '文件含 NUL 字节，按二进制处理，不进编辑器')
      }
      return { content: buffer.toString('utf8'), mtime: info.mtime, size: info.size }
    },

    async write(workspace, segments, content, options) {
      assertValidSegments(segments)
      if (segments.length === 0) throw new ProviderError('bad_request', 400, 'write 需要文件路径')
      const { sshArgs } = await resolve(parse(workspace.root))
      const absolute = await resolveInsideRoot(sshArgs, parse(workspace.root).path, segments)
      const payload = Buffer.from(content, 'utf8').toString('base64')
      // 乐观锁与原子写都在远端一次完成：mtime 比对、临时文件、rename。
      const expect = options.expectMtime === undefined ? '' : String(Math.floor(options.expectMtime / 1000))
      const out = await execRemote(
        sshArgs,
        `t=${quote(absolute)}
overwrite=${options.overwrite ? 1 : 0}; expect=${quote(expect)}
if [ -e "$t" ]; then
  now=$(stat -c %Y -- "$t")
  if [ "$overwrite" = 0 ]; then
    if [ -z "$expect" ]; then echo CONFLICT_CREATED; exit 0; fi
    if [ "$now" != "$expect" ]; then echo CONFLICT_MODIFIED; exit 0; fi
  fi
else
  if [ "$overwrite" = 0 ] && [ -n "$expect" ]; then echo CONFLICT_DELETED; exit 0; fi
fi
tmp="$(dirname -- "$t")/.$(basename -- "$t").ww-tmp-$$-$(date +%s%N)"
printf '%s' ${quote(payload)} | base64 -d > "$tmp" || { rm -f "$tmp"; exit 45; }
mv -f -- "$tmp" "$t" || { rm -f "$tmp"; exit 46; }
stat -c %Y -- "$t"`,
      ).catch((error) => mapRemoteError(error, segments))
      const trimmed = out.trim()
      if (trimmed.startsWith('CONFLICT_')) {
        const kind = trimmed.slice('CONFLICT_'.length)
        const reason =
          kind === 'CREATED' ? '文件已被外部创建，刷新后再保存'
          : kind === 'DELETED' ? '文件已被外部删除，刷新后再保存'
          : '文件已被外部修改（mtime 不一致）'
        throw new ProviderError('conflict', 409, reason)
      }
      if (!/^\d+$/.test(trimmed)) throw new ProviderError('io', 500, `写入后取 mtime 失败：${trimmed}`)
      return { mtime: Number(trimmed) * 1000 }
    },

    async stat(workspace, segments) {
      assertValidSegments(segments)
      const { sshArgs } = await resolve(parse(workspace.root))
      const absolute = await resolveInsideRoot(sshArgs, parse(workspace.root).path, segments)
      const info = await remoteStat(sshArgs, absolute, segments)
      return { name: info.name || workspace.id, type: info.type, size: info.size, mtime: info.mtime }
    },

    async mkdir(workspace, segments) {
      assertValidSegments(segments)
      if (segments.length === 0) throw new ProviderError('bad_request', 400, 'mkdir 需要目录名')
      const { sshArgs } = await resolve(parse(workspace.root))
      const absolute = await resolveInsideRoot(sshArgs, parse(workspace.root).path, segments)
      await execRemote(sshArgs, `mkdir -- ${quote(absolute)}`).catch((error) => mapRemoteError(error, segments))
      const info = await remoteStat(sshArgs, absolute, segments)
      return { name: segments[segments.length - 1], type: 'dir', size: 0, mtime: info.mtime }
    },

    async rename(workspace, segments, newName) {
      assertValidSegments(segments)
      if (segments.length === 0) throw new ProviderError('bad_request', 400, 'rename 需要条目路径')
      assertValidSegment(newName)
      const { sshArgs } = await resolve(parse(workspace.root))
      const root = parse(workspace.root).path
      const absolute = await resolveInsideRoot(sshArgs, root, segments)
      const target = await resolveInsideRoot(sshArgs, root, [...segments.slice(0, -1), newName])
      await execRemote(sshArgs, `mv -n -- ${quote(absolute)} ${quote(target)}`).catch((error) => mapRemoteError(error, segments))
      const info = await remoteStat(sshArgs, target, segments)
      return { name: newName, type: info.type, size: info.size, mtime: info.mtime }
    },

    async delete(workspace, segments) {
      assertValidSegments(segments)
      if (segments.length === 0) throw new ProviderError('bad_request', 400, '不能删除 workspace 根目录')
      const { sshArgs } = await resolve(parse(workspace.root))
      const absolute = await resolveInsideRoot(sshArgs, parse(workspace.root).path, segments)
      const info = await remoteStat(sshArgs, absolute, segments)
      const flag = info.type === 'dir' ? '-rf' : '-f'
      await execRemote(sshArgs, `rm ${flag} -- ${quote(absolute)}`).catch((error) => mapRemoteError(error, segments))
    },
  }
  return provider
}
