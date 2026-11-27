import http from 'node:http'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse, type Location, type Scheme } from '@ursi/location'
import { keyOf } from '@ursi/location/keys'
import {
  createLocalProvider,
  loadWorkspaceConfig,
  parseWorkspaceSeed,
  ProviderError,
  type WorkspaceProvider,
} from './local-provider.ts'
import { createSshProvider } from './ssh-provider.ts'
import type { ApiError, DirListingDto, WorkspaceConfig, WorkspaceInfo } from './types.ts'

/** 内存中的 workspace 记录：配置 + 探活结果 + 规范位置（用于重复检测）。 */
interface WorkspaceRecord extends WorkspaceConfig {
  ready?: boolean
  error?: string
  /** root 规范化后的位置（本机经过 realpath）；root 不可达时为 null。 */
  realRoot: Location | null
}

export interface ServerOptions {
  /** 运行时状态文件路径；不传则不持久化（测试默认）。 */
  stateFile?: string
  /** ssh-web 的 API 基址（如 `http://127.0.0.1:8091/api`）；不传则 ssh 目录不可用。 */
  sshWebApi?: string
}

/** 状态文件默认位置：XDG_STATE_HOME 优先，回退 ~/.local/state。 */
function defaultStateFile(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
  return path.join(base, 'fs-web', 'workspaces.json')
}

/**
 * 对 root 做一次探活并取规范位置（本机 realpath，远程 realpath 经 ssh）；不阻塞启动，
 * 未就绪的 workspace 保留错误信息。
 */
async function probeWorkspace(
  config: WorkspaceConfig,
  providers: Record<Scheme, WorkspaceProvider>,
): Promise<WorkspaceRecord> {
  try {
    const realRoot = await providers[config.provider].realize(config.root)
    return { ...config, realRoot }
  } catch (error) {
    return {
      ...config,
      realRoot: null,
      ready: false,
      error: `root 不可达：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** 落盘快照只保留契约字段，不写内存探活产物。 */
function cleanConfig(record: WorkspaceRecord): WorkspaceConfig {
  return {
    id: record.id,
    label: record.label ?? record.id,
    description: record.description,
    provider: record.provider,
    root: record.root,
  }
}

/** 跨重启稳定的 id：root 规范位置 URI 的 sha256 前 16 个 hex 字符（64 位）。 */
function workspaceIdOf(realRoot: Location): Promise<string> {
  return keyOf(realRoot)
}

function labelFromRoot(realRoot: Location): string {
  // 设备根目录没有名字，用设备名当标签。
  return realRoot.path === '/' ? (realRoot.device ?? '本机') : realRoot.path.slice(realRoot.path.lastIndexOf('/') + 1)
}

export async function createServer(
  seedConfigs: readonly WorkspaceConfig[],
  options: ServerOptions = {},
): Promise<http.Server> {
  let seeds = seedConfigs.map((config) => parseWorkspaceSeed(config, 'createServer(seedConfigs)'))
  const stateFile = options.stateFile
  const workspaces = new Map<string, WorkspaceRecord>()
  // 按 scheme 选 provider；ssh 需要注入 ssh-web 地址，否则 ssh 目录一律不可用。
  const providers: Record<Scheme, WorkspaceProvider> = {
    file: createLocalProvider(),
    ssh: options.sshWebApi ? createSshProvider({ api: options.sshWebApi }) : unavailableProvider('ssh', '未配置 SSH_WEB_API'),
  }

  function providerOf(workspace: WorkspaceRecord): WorkspaceProvider {
    return providers[workspace.provider]
  }

  // 状态文件写盘串行化：连续 add/rename/remove 的读改写按调用顺序落盘。
  let persistChain: Promise<void> = Promise.resolve()

  /** 原子落盘：同目录临时文件 + rename。调用方先构造好落盘快照，再改内存。 */
  function persistNow(snapshot: WorkspaceConfig[]): Promise<void> {
    if (!stateFile) return Promise.resolve()
    const write = persistChain.then(async () => {
      await fs.mkdir(path.dirname(stateFile), { recursive: true })
      const temp = path.join(path.dirname(stateFile), `.${path.basename(stateFile)}.tmp-${process.pid}`)
      await fs.writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      await fs.rename(temp, stateFile)
    })
    persistChain = write.catch(() => {})
    return write
  }

  /** 从状态文件加载清单；文件损坏或条目非法直接抛错（fail fast，不静默回退）。 */
  async function loadStateFile(): Promise<boolean> {
    if (!stateFile) return false
    let raw: string
    try {
      raw = readFileSync(stateFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`状态文件不是合法 JSON：${stateFile}（${error instanceof Error ? error.message : String(error)}）`)
    }
    if (!Array.isArray(parsed)) throw new Error(`状态文件应为 workspace 数组：${stateFile}`)
    const seen = new Set<string>()
    const configs = parsed.map((item) => {
      const config = parseWorkspaceSeed(item, stateFile)
      if (seen.has(config.id)) throw new Error(`状态文件中 workspace id 重复：${config.id}`)
      seen.add(config.id)
      return config
    })
    for (const config of configs) {
      workspaces.set(config.id, await probeWorkspace(config, providers))
    }
    return true
  }

  async function loadSeedConfigs(): Promise<void> {
    for (const config of seeds) {
      workspaces.set(config.id, await probeWorkspace(config, providers))
    }
    if (stateFile) {
      // 首次落盘：把种子清单固化为状态文件，此后状态文件是唯一事实源。
      await persistNow([...workspaces.values()].map(cleanConfig))
    }
  }

  await loadStateFile() || (await loadSeedConfigs())

  function getWorkspace(id: unknown): WorkspaceRecord {
    if (typeof id !== 'string') throw new ProviderError('bad_request', 400, 'workspaceId 缺失')
    const workspace = workspaces.get(id)
    if (!workspace) throw new ProviderError('workspace_not_found', 404, `workspace 不存在：${id}`)
    if (workspace.ready === false) {
      throw new ProviderError('workspace_not_ready', 503, workspace.error ?? 'workspace 未就绪')
    }
    return workspace
  }

  function infoOf(workspace: WorkspaceRecord): WorkspaceInfo {
    return {
      id: workspace.id,
      label: workspace.label ?? workspace.id,
      description: workspace.description,
      provider: workspace.provider,
      root: workspace.root,
      ready: workspace.ready !== false,
      error: workspace.error,
    }
  }

  function workspaceList(): WorkspaceInfo[] {
    return [...workspaces.values()].map(infoOf)
  }

  /**
   * 任意目录浏览：给「添加目录」等未登记路径的选目录场景用，不经 workspace 清单、
   * 不受 root 约束（只读列目录）。目标是位置 URI 或本机简写，由对应 provider 解析与校验。
   * 本机 `~` 在这里展开；远程位置需要 ssh provider 可用。
   */
  async function browseDir(query: URLSearchParams): Promise<DirListingDto> {
    const raw = (query.get('path') ?? '').trim()
    if (!raw) throw new ProviderError('bad_request', 400, 'path 缺失')
    let target: Location
    try {
      target = parse(raw, { home: os.homedir() })
    } catch (error) {
      throw new ProviderError('bad_request', 400, error instanceof Error ? error.message : String(error))
    }
    const listing = await providers[target.scheme].browse(raw)
    return {
      location: listing.location.uri,
      parent: listing.parent?.uri ?? null,
      entries: listing.entries,
    }
  }

  /** 运行时添加目录：位置 URI → provider 规范化（本机 realpath / 远程 realpath）→ 必须是目录 → 位置键 id → 落盘 → 入清单。 */
  async function addWorkspace(body: Record<string, unknown>): Promise<WorkspaceInfo> {
    const root = body.root
    if (typeof root !== 'string' || root.length === 0) {
      throw new ProviderError('bad_request', 400, `root 必须是位置 URI：${JSON.stringify(root)}`)
    }
    let scheme: Scheme
    try {
      scheme = parse(root, { home: os.homedir() }).scheme
    } catch (error) {
      throw new ProviderError('bad_request', 400, error instanceof Error ? error.message : String(error))
    }
    const realRoot = await providers[scheme].realize(root)
    const id = await workspaceIdOf(realRoot)
    for (const workspace of workspaces.values()) {
      if (workspace.realRoot?.uri === realRoot.uri) {
        throw new ProviderError('exists', 409, `目录已在清单中：${workspace.label}（${realRoot.uri}）`)
      }
      if (workspace.id === id) {
        throw new ProviderError('exists', 409, `workspace id 冲突：${id}`)
      }
    }
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : labelFromRoot(realRoot)
    const config: WorkspaceConfig = { id, label, provider: realRoot.scheme, root: realRoot.uri }
    const record = await probeWorkspace(config, providers)
    await persistNow([...workspaces.values()].map(cleanConfig).concat(config))
    workspaces.set(id, record)
    return infoOf(record)
  }

  /** 重命名只改显示名；id 与 root 不变，前端 FileKey 与草稿无需迁移。 */
  async function renameWorkspace(body: Record<string, unknown>): Promise<WorkspaceInfo> {
    const workspace = getWorkspace(body.workspaceId)
    // 按键存在判断：传空字符串 description 表示清除说明；label 不允许空。
    const hasLabel = typeof body.label === 'string'
    const hasDescription = typeof body.description === 'string'
    if (!hasLabel && !hasDescription) {
      throw new ProviderError('bad_request', 400, 'label 与 description 至少提供一项')
    }
    const label = hasLabel ? body.label.trim() : undefined
    const description = hasDescription ? body.description.trim() : undefined
    if (hasLabel && !label) {
      throw new ProviderError('bad_request', 400, 'label 不能为空字符串')
    }
    if ((label && label.length > 255) || (description && description.length > 500)) {
      throw new ProviderError('bad_request', 400, 'label 超过 255 字符或 description 超过 500 字符')
    }
    const renamed: WorkspaceRecord = {
      ...workspace,
      label: label ?? workspace.label,
      description: hasDescription ? description || undefined : workspace.description,
    }
    await persistNow(
      [...workspaces.values()].map((item) => cleanConfig(item.id === workspace.id ? renamed : item)),
    )
    workspaces.set(workspace.id, renamed)
    return infoOf(renamed)
  }

  /** 从清单移除；只动清单，不删文件系统。允许移除未就绪（root 已消失）的条目。 */
  async function removeWorkspace(body: Record<string, unknown>): Promise<{ ok: true }> {
    const id = body.workspaceId
    if (typeof id !== 'string') throw new ProviderError('bad_request', 400, 'workspaceId 缺失')
    if (!workspaces.has(id)) throw new ProviderError('workspace_not_found', 404, `workspace 不存在：${id}`)
    await persistNow(
      [...workspaces.values()].filter((item) => item.id !== id).map(cleanConfig),
    )
    workspaces.delete(id)
    return { ok: true }
  }

  const MAX_BODY_BYTES = 5 * 1024 * 1024 // 保存请求体上限：2MB 文本 + JSON 余量

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      req.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_BODY_BYTES) {
          reject(new ProviderError('too_large', 413, `请求体超过 ${MAX_BODY_BYTES} 字节`))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readBody(req)
    if (raw.length === 0) return {}
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new ProviderError('bad_request', 400, '请求体应为 JSON 对象')
      }
      return parsed as Record<string, unknown>
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError('bad_request', 400, `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function send(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  /** path 字段：相对 workspace root 的 segments。 */
  function pathOf(body: Record<string, unknown>): string[] {
    return Array.isArray(body.path) ? (body.path as unknown[]) : []
  }

  /**
   * 跨站防护：浏览器发起的跨站请求必带 Origin。拒绝 Origin 主机既不是回环地址、
   * 也不等于 Host 头主机名的请求（挡住恶意网页盲打本服务）；curl 等无 Origin 的客户端不受影响。
   */
  function assertSameOrigin(req: http.IncomingMessage): void {
    const origin = req.headers.origin
    if (!origin) return
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new ProviderError('forbidden_origin', 403, `Origin 不合法：${origin}`)
    }
    const hostname = parsed.hostname
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1') return
    const host = req.headers.host ?? ''
    // Host 头形如 host:port；IPv6 是 [::1]:port。
    const hostName = host.startsWith('[')
      ? host.slice(1, host.indexOf(']'))
      : host.includes(':')
        ? host.slice(0, host.lastIndexOf(':'))
        : host
    if (hostname === hostName) return
    throw new ProviderError('forbidden_origin', 403, `拒绝跨站请求：Origin ${origin} 与服务主机不符`)
  }

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<void> {
    const prefix = '/api/fs-web/'
    if (!pathname.startsWith(prefix)) {
      send(res, 404, { code: 'bad_request', message: '未知接口' } satisfies ApiError)
      return
    }
    assertSameOrigin(req)
    const route = pathname.slice(prefix.length).replace(/\/+$/, '')

    if (req.method === 'GET' && route === 'workspaces') {
      send(res, 200, workspaceList())
      return
    }

    if (req.method === 'GET' && route === 'browse') {
      send(res, 200, await browseDir(new URL(req.url ?? '/', 'http://localhost').searchParams))
      return
    }

    if (req.method !== 'POST') {
      send(res, 405, { code: 'bad_request', message: '本服务除 GET workspaces、GET browse 外一律 POST + JSON' } satisfies ApiError)
      return
    }

    // workspace 清单管理路由：自己解析 workspaceId（remove 允许处理未就绪条目，不走 ready 守卫）。
    if (route === 'workspaces-add' || route === 'workspaces-rename' || route === 'workspaces-remove') {
      const body = await readJsonBody(req)
      if (route === 'workspaces-add') {
        send(res, 200, await addWorkspace(body))
      } else if (route === 'workspaces-rename') {
        send(res, 200, await renameWorkspace(body))
      } else {
        send(res, 200, await removeWorkspace(body))
      }
      return
    }

    const body = await readJsonBody(req)
    const workspace = getWorkspace(body.workspaceId)
    const segments = pathOf(body)

    switch (route) {
      case 'list': {
        send(res, 200, { entries: await providerOf(workspace).list(workspace, segments) })
        return
      }
      case 'read': {
        send(res, 200, await providerOf(workspace).read(workspace, segments))
        return
      }
      case 'write': {
        if (typeof body.content !== 'string') {
          throw new ProviderError('bad_request', 400, 'content 缺失')
        }
        const result = await providerOf(workspace).write(workspace, segments, body.content, {
          expectMtime: typeof body.expectMtime === 'number' ? body.expectMtime : undefined,
          overwrite: body.overwrite === true,
        })
        send(res, 200, result)
        return
      }
      case 'stat': {
        send(res, 200, await providerOf(workspace).stat(workspace, segments))
        return
      }
      case 'git-status': {
        if (typeof providerOf(workspace).gitStatus !== 'function') {
          throw new ProviderError('git_unavailable', 501, '该目录不支持 git 状态')
        }
        send(res, 200, await providerOf(workspace).gitStatus(workspace))
        return
      }
      case 'git-branches': {
        if (typeof providerOf(workspace).gitBranches !== 'function') {
          throw new ProviderError('git_unavailable', 501, '当前 provider 不支持 git 分支')
        }
        send(res, 200, await providerOf(workspace).gitBranches(workspace))
        return
      }
      case 'git-push': {
        if (typeof providerOf(workspace).gitPush !== 'function') {
          throw new ProviderError('git_unavailable', 501, '当前 provider 不支持 git 同步')
        }
        send(res, 200, await providerOf(workspace).gitPush(workspace))
        return
      }
      case 'git-pull': {
        if (typeof providerOf(workspace).gitPull !== 'function') {
          throw new ProviderError('git_unavailable', 501, '当前 provider 不支持 git 同步')
        }
        send(res, 200, await providerOf(workspace).gitPull(workspace))
        return
      }
      case 'mkdir': {
        send(res, 200, await providerOf(workspace).mkdir(workspace, segments))
        return
      }
      case 'rename': {
        if (typeof body.newName !== 'string') {
          throw new ProviderError('bad_request', 400, 'newName 缺失')
        }
        send(res, 200, await providerOf(workspace).rename(workspace, segments, body.newName))
        return
      }
      case 'delete': {
        await providerOf(workspace).delete(workspace, segments)
        send(res, 200, { ok: true })
        return
      }
      default:
        send(res, 404, { code: 'bad_request', message: `未知接口：${route}` } satisfies ApiError)
    }
  }

  return http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    handle(req, res, pathname).catch((error) => {
      if (res.writableEnded) return
      if (error instanceof ProviderError) {
        send(res, error.status, { code: error.code, message: error.message } satisfies ApiError)
        return
      }
      send(res, 500, {
        code: 'io',
        message: error instanceof Error ? error.message : String(error),
      } satisfies ApiError)
    })
  })
}

interface StartOptions {
  host?: string
  port?: number
}

export async function start(options: StartOptions = {}): Promise<http.Server> {
  const configs = loadWorkspaceConfig(process.env)
  const stateFile = process.env.FS_WEB_STATE || defaultStateFile()
  const sshWebApi = process.env.SSH_WEB_API
  const host = options.host ?? process.env.FS_WEB_HOST ?? '0.0.0.0'
  const port = options.port ?? Number(process.env.FS_WEB_PORT ?? 8199)
  const server = await createServer(configs, { stateFile, sshWebApi })
  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  console.log(
    `fs-web listening on http://${host}:${port}（状态文件：${stateFile}；ssh：${sshWebApi ? sshWebApi : '未配置 SSH_WEB_API，远程目录不可用'}）`,
  )
  return server
}

// 直接运行时启动：node fs-web/server/src/server.ts --host 0.0.0.0 --port 8199
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  void start({ host: flag('--host'), port: flag('--port') ? Number(flag('--port')) : undefined })
}

/** 占位 provider：能力未配置时每个操作都给出明确原因，而不是悄悄退化。 */
function unavailableProvider(scheme: Scheme, reason: string): WorkspaceProvider {
  const fail = (): never => {
    throw new ProviderError(`${scheme}_unavailable` as ApiError['code'], 503, `${scheme} 目录不可用：${reason}`)
  }
  return {
    list: fail,
    read: fail,
    write: fail,
    stat: fail,
    mkdir: fail,
    rename: fail,
    delete: fail,
    realize: fail,
    browse: fail,
  }
}
