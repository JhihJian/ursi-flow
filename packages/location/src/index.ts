/**
 * 位置契约。
 *
 * 工作目录的身份是一个 URI：
 *
 *   file:///abs/path           本机（工作台服务所在机器）
 *   ssh://<设备名>/abs/path    远程，设备名是 ssh-web 的连接名
 *
 * 形态借自 RFC 3986，与 git、GVfs、sshfs 一致，所以长期稳定。
 * 但不经 URL 解析器：OpenSSH 的 Host 别名大小写敏感，而 URL 解析器会把主机名小写化。
 * 路径段用 percent-encoding，空格、中文、`#`、`%` 全部可逆。
 *
 * 三条边界：URI 是身份，不是存储键（键用 keyOf）；是契约，不是服务；
 * 是借形态，不是借解析器。
 */

export type Scheme = 'file' | 'ssh'

/** 设备名规则：ssh-web 的连接名。不出现 `user@`、`:port`，那些归连接命令表达。 */
const DEVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export type LocationErrorCode = 'invalid_uri' | 'unsupported_scheme' | 'bad_device' | 'relative_path'

export class LocationError extends Error {
  readonly code: LocationErrorCode
  constructor(code: LocationErrorCode, message: string) {
    super(message)
    this.name = 'LocationError'
    this.code = code
  }
}

/** 契约位置。`uri` 是唯一事实源，其余字段是解析结果。 */
export interface Location {
  /** 规范化后的 URI。 */
  uri: string
  scheme: Scheme
  /** 远程设备名；本机为 null。 */
  device: string | null
  /** 设备内绝对路径，POSIX，以 `/` 开头，无尾斜杠（根目录为 `/`）。 */
  path: string
}

/**
 * 解析 URI 或本机路径简写。
 *
 * - `file:///abs`、`/abs`、`~/x` 都解析为本机位置。
 * - `ssh://<device>/abs` 解析为远程位置。
 * - 其它 scheme 报 unsupported_scheme；相对路径报 relative_path。
 * - `~` 与 `~/x` 需要 `home`，未提供时报 relative_path。
 */
export function parse(input: string, options: { home?: string } = {}): Location {
  const raw = input.trim()
  if (!raw) throw new LocationError('invalid_uri', '位置为空')

  const schemeEnd = raw.indexOf('://')
  if (schemeEnd < 0) {
    const path = resolveLocalPath(raw, options.home)
    return { uri: encode('file', null, path), scheme: 'file', device: null, path }
  }

  const scheme = raw.slice(0, schemeEnd)
  const rest = raw.slice(schemeEnd + 3)
  if (scheme !== 'file' && scheme !== 'ssh') {
    throw new LocationError('unsupported_scheme', `不支持的位置类型：${scheme}://`)
  }

  const slash = rest.indexOf('/')
  const authority = slash < 0 ? rest : rest.slice(0, slash)
  const encodedPath = slash < 0 ? '' : rest.slice(slash)

  if (scheme === 'file') {
    if (authority !== '' && authority !== 'localhost') {
      throw new LocationError('invalid_uri', 'file:// 后不接设备名，本机位置写成 file:///abs')
    }
    const path = normalizePath(decodedSegments(encodedPath))
    return makeFile(path)
  }

  if (!authority) throw new LocationError('bad_device', 'ssh:// 缺少设备名')
  if (!DEVICE_PATTERN.test(authority)) {
    throw new LocationError(
      'bad_device',
      `设备名非法：${authority}（只允许字母、数字、点、下划线、短横线；用户与端口由 ssh-web 的连接命令表达）`,
    )
  }
  const path = normalizePath(decodedSegments(encodedPath))
  return makeSsh(authority, path)
}

function makeFile(path: string): Location {
  return { uri: encode('file', null, path), scheme: 'file', device: null, path }
}

function makeSsh(device: string, path: string): Location {
  return { uri: encode('ssh', device, path), scheme: 'ssh', device, path }
}

/** 本机路径简写：`/abs`、`~`、`~/x`。返回规范化后的绝对路径。 */
function resolveLocalPath(raw: string, home: string | undefined): string {
  let target = raw
  if (raw === '~' || raw.startsWith('~/')) {
    if (!home) throw new LocationError('relative_path', '解析 `~` 需要提供 home')
    target = home + raw.slice(1)
  }
  if (!target.startsWith('/')) {
    throw new LocationError('relative_path', `位置必须是绝对路径或 URI：${raw}`)
  }
  return normalizePath(target.split('/'))
}

/**
 * 构造位置。路径按段编码后拼接，文件名里的 `/` `#` `?` `%` 空格 中文都不会破坏 URI。
 * `path` 必须是设备内绝对路径。
 */
export function build(scheme: 'file', path: string): Location
export function build(scheme: 'ssh', device: string, path: string): Location
export function build(scheme: Scheme, a: string, b?: string): Location {
  if (scheme === 'file') return makeFile(normalizePath(requireAbsolute(a).split('/')))
  const device = a
  const path = requireAbsolute(b ?? '/')
  if (!DEVICE_PATTERN.test(device)) throw new LocationError('bad_device', `设备名非法：${device}`)
  return makeSsh(device, normalizePath(path.split('/')))
}

function requireAbsolute(path: string): string {
  if (!path.startsWith('/')) throw new LocationError('relative_path', `路径必须是绝对路径：${path}`)
  return path
}

export function format(loc: Location): string {
  return loc.uri
}

/** 父目录；根目录为 null。 */
export function parentOf(loc: Location): Location | null {
  if (loc.path === '/') return null
  const parent = loc.path.slice(0, loc.path.lastIndexOf('/')) || '/'
  return loc.scheme === 'file' ? makeFile(parent) : makeSsh(loc.device!, parent)
}

/** 子目录。`name` 必须是单段名称。 */
export function childOf(loc: Location, name: string): Location {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new LocationError('invalid_uri', `非法的目录名：${JSON.stringify(name)}`)
  }
  const child = joinPath(loc.path, name)
  return loc.scheme === 'file' ? makeFile(child) : makeSsh(loc.device!, child)
}

/** 末段名称；根目录为 `/`。 */
export function basename(loc: Location): string {
  if (loc.path === '/') return '/'
  return loc.path.slice(loc.path.lastIndexOf('/') + 1)
}

/** 路径分段（不含根）：`/a/b` → ['a', 'b']。 */
export function pathSegmentsOf(loc: Location): string[] {
  return loc.path === '/' ? [] : loc.path.slice(1).split('/')
}

/** 面包屑：每一段带它自己的位置。 */
export function crumbs(loc: Location): { name: string; loc: Location }[] {
  return pathSegmentsOf(loc).map((name, index, parts) => {
    const path = '/' + parts.slice(0, index + 1).join('/')
    return { name, loc: loc.scheme === 'file' ? makeFile(path) : makeSsh(loc.device!, path) }
  })
}

/** 同一设备下的两个位置。 */
export function sameDevice(a: Location, b: Location): boolean {
  return a.scheme === b.scheme && a.device === b.device
}

/** `child` 是否位于 `root` 之内（含相等）。 */
export function isWithin(root: Location, child: Location): boolean {
  if (!sameDevice(root, child)) return false
  if (root.path === '/') return true
  return child.path === root.path || child.path.startsWith(root.path + '/')
}

/** 持久化键：规范 URI 的 sha256 前 16 个 hex。跨进程稳定，算法与 fs-web、pi-web 现有做法一致。 */
export async function keyOf(loc: Location): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(loc.uri).digest('hex').slice(0, 16)
}

/** 两个位置是否是同一个位置。 */
export function equals(a: Location, b: Location): boolean {
  return a.uri === b.uri
}

function encode(scheme: Scheme, device: string | null, path: string): string {
  const authority = device ?? ''
  const encoded = path === '/' ? '/' : '/' + path.slice(1).split('/').map(encodeURIComponent).join('/')
  return `${scheme}://${authority}${encoded}`
}

/** 把 `/a%20b/c` 形态的编码路径拆成解码后的段；不存在的段忽略。 */
function decodedSegments(encodedPath: string): string[] {
  return encodedPath.split('/').filter((segment) => segment !== '').map(decodeSegment)
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new LocationError('invalid_uri', `路径段编码非法：${segment}`)
  }
}

/**
 * 路径规范化，只做三件事：以 `/` 开头，折叠连续斜杠，去尾斜杠。
 * 不折叠 `..`：文件系统给什么就是什么，越界由各 provider 的 realpath 防护负责。
 */
function normalizePath(segments: string[]): string {
  const filtered = segments.filter((segment) => segment !== '')
  return '/' + filtered.join('/')
}

function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}
