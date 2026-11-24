import http from 'node:http'
import { promises as fs } from 'node:fs'
import { createLocalProvider, loadWorkspaceConfig, ProviderError } from './local-provider.ts'
import type { ApiError, WorkspaceConfig, WorkspaceInfo } from './types.ts'

const provider = createLocalProvider()
const workspaces = new Map<string, WorkspaceConfig & { ready?: boolean; error?: string }>()

/** 启动时对每个 root 做 realpath 探活；不阻塞启动，未就绪的 workspace 保留错误信息。 */
async function loadWorkspacesFrom(configs: WorkspaceConfig[]): Promise<void> {
  workspaces.clear()
  for (const config of configs) {
    try {
      await fs.realpath(config.root)
      workspaces.set(config.id, { ...config })
    } catch (error) {
      workspaces.set(config.id, {
        ...config,
        ready: false,
        error: `root 不可达：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
}

function getWorkspace(id: unknown): WorkspaceConfig {
  if (typeof id !== 'string') throw new ProviderError('bad_request', 400, 'workspaceId 缺失')
  const workspace = workspaces.get(id)
  if (!workspace) throw new ProviderError('workspace_not_found', 404, `workspace 不存在：${id}`)
  if (workspace.ready === false) {
    throw new ProviderError('workspace_not_ready', 503, workspace.error ?? 'workspace 未就绪')
  }
  return workspace
}

function workspaceList(): WorkspaceInfo[] {
  return [...workspaces.values()].map((workspace) => ({
    id: workspace.id,
    label: workspace.label ?? workspace.id,
    provider: 'local',
    ready: workspace.ready !== false,
    error: workspace.error,
  }))
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

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  const prefix = '/api/workspace-web/'
  if (!pathname.startsWith(prefix)) {
    send(res, 404, { code: 'bad_request', message: '未知接口' } satisfies ApiError)
    return
  }
  const route = pathname.slice(prefix.length).replace(/\/+$/, '')

  if (req.method === 'GET' && route === 'workspaces') {
    send(res, 200, workspaceList())
    return
  }

  if (req.method !== 'POST') {
    send(res, 405, { code: 'bad_request', message: '本服务除 GET workspaces 外一律 POST + JSON' } satisfies ApiError)
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

/** 异步工厂：先探活 root 再建服务；测试传配置数组，start 从环境读清单。 */
export async function createServer(configs: WorkspaceConfig[]): Promise<http.Server> {
  await loadWorkspacesFrom(configs)
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
  const host = options.host ?? process.env.WORKSPACE_WEB_HOST ?? '127.0.0.1'
  const port = options.port ?? Number(process.env.WORKSPACE_WEB_PORT ?? 8199)
  const server = await createServer(configs)
  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  console.log(`workspace-web listening on http://${host}:${port}`)
  return server
}

// 直接运行时启动：node workspace-web/server/src/server.ts --host 0.0.0.0 --port 8199
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  void start({ host: flag('--host'), port: flag('--port') ? Number(flag('--port')) : undefined })
}
