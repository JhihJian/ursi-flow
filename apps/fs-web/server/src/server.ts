import http from 'node:http'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  createLocalProvider,
  loadWorkspaceConfig,
  parseWorkspaceSeed,
  ProviderError,
} from './local-provider.ts'
import type { ApiError, GitStatusDto, WorkspaceConfig, WorkspaceInfo } from './types.ts'

/** 内存中的 workspace 记录：配置 + 探活结果 + realpath（用于重复检测）。 */
interface WorkspaceRecord extends WorkspaceConfig {
  ready?: boolean
  error?: string
  /** root 的 realpath；root 不可达时为 null。 */
  realRoot: string | null
}

export interface ServerOptions {
  /** 运行时状态文件路径；不传则不持久化（测试默认）。 */
  stateFile?: string
}

/** 状态文件默认位置：XDG_STATE_HOME 优先，回退 ~/.local/state。 */
function defaultStateFile(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
  return path.join(base, 'fs-web', 'workspaces.json')
}

/** 启动时对每个 root 做 realpath 探活；不阻塞启动，未就绪的 workspace 保留错误信息。 */
async function probeWorkspace(config: WorkspaceConfig): Promise<WorkspaceRecord> {
  try {
    const realRoot = await fs.realpath(config.root)
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

/** 跨重启稳定的 id：root realpath 的 sha256 前 16 个 hex 字符（64 位）。 */
function workspaceIdOf(realRoot: string): string {
  return createHash('sha256').update(realRoot).digest('hex').slice(0, 16)
}

function labelFromRoot(realRoot: string): string {
  return path.basename(realRoot) || realRoot
}

export async function createServer(
  seedConfigs: WorkspaceConfig[],
  options: ServerOptions = {},
): Promise<http.Server> {
  const provider = createLocalProvider()
  const stateFile = options.stateFile
  const workspaces = new Map<string, WorkspaceRecord>()

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
      workspaces.set(config.id, await probeWorkspace(config))
    }
    return true
  }

  async function loadSeedConfigs(): Promise<void> {
    for (const config of seedConfigs) {
      workspaces.set(config.id, await probeWorkspace(config))
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
      provider: 'local',
      root: workspace.root,
      ready: workspace.ready !== false,
      error: workspace.error,
    }
  }

  function workspaceList(): WorkspaceInfo[] {
    return [...workspaces.values()].map(infoOf)
  }

  /** 运行时添加目录：absolute path → realpath → 必须是目录 → 哈希 id → 落盘 → 入清单。 */
  async function addWorkspace(body: Record<string, unknown>): Promise<WorkspaceInfo> {
    const root = body.root
    if (typeof root !== 'string' || root.length === 0 || !path.isAbsolute(root)) {
      throw new ProviderError('bad_request', 400, `root 必须是绝对路径：${JSON.stringify(root)}`)
    }
    let realRoot: string
    try {
      realRoot = await fs.realpath(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ProviderError('not_found', 404, `目录不存在：${root}`)
      }
      throw new ProviderError('io', 500, error instanceof Error ? error.message : String(error))
    }
    const stats = await fs.stat(realRoot).catch((error) => {
      throw new ProviderError('io', 500, error instanceof Error ? error.message : String(error))
    })
    if (!stats.isDirectory()) {
      throw new ProviderError('bad_request', 400, `不是目录：${realRoot}`)
    }
    const id = workspaceIdOf(realRoot)
    for (const workspace of workspaces.values()) {
      if (workspace.realRoot === realRoot) {
        throw new ProviderError('exists', 409, `目录已在清单中：${workspace.label}（${realRoot}）`)
      }
      if (workspace.id === id) {
        throw new ProviderError('exists', 409, `workspace id 冲突：${id}`)
      }
    }
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : labelFromRoot(realRoot)
    const config: WorkspaceConfig = { id, label, provider: 'local', root: realRoot }
    const record = await probeWorkspace(config)
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

    if (req.method !== 'POST') {
      send(res, 405, { code: 'bad_request', message: '本服务除 GET workspaces 外一律 POST + JSON' } satisfies ApiError)
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
        send(res, 200, { entries: await provider.list(workspace, segments) })
        return
      }
      case 'read': {
        send(res, 200, await provider.read(workspace, segments))
        return
      }
      case 'write': {
        if (typeof body.content !== 'string') {
          throw new ProviderError('bad_request', 400, 'content 缺失')
        }
        const result = await provider.write(workspace, segments, body.content, {
          expectMtime: typeof body.expectMtime === 'number' ? body.expectMtime : undefined,
          overwrite: body.overwrite === true,
        })
        send(res, 200, result)
        return
      }
      case 'stat': {
        send(res, 200, await provider.stat(workspace, segments))
        return
      }
      case 'git-status': {
        if (typeof provider.gitStatus !== 'function') {
          throw new ProviderError('git_unavailable', 501, '当前 provider 不支持 git 状态')
        }
        send(res, 200, await provider.gitStatus(workspace))
        return
      }
      case 'mkdir': {
        send(res, 200, await provider.mkdir(workspace, segments))
        return
      }
      case 'rename': {
        if (typeof body.newName !== 'string') {
          throw new ProviderError('bad_request', 400, 'newName 缺失')
        }
        send(res, 200, await provider.rename(workspace, segments, body.newName))
        return
      }
      case 'delete': {
        await provider.delete(workspace, segments)
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
  const host = options.host ?? process.env.FS_WEB_HOST ?? '127.0.0.1'
  const port = options.port ?? Number(process.env.FS_WEB_PORT ?? 8199)
  const server = await createServer(configs, { stateFile })
  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  console.log(`fs-web listening on http://${host}:${port}（状态文件：${stateFile}）`)
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
