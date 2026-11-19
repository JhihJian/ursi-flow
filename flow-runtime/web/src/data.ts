// 数据层：与 workbench 的 /api/v1 契约一致，实时模式由同源 server.mjs 转发到 ursi-flowd。
export type FlowFiles = Record<string, string>
export interface Revision {
  id: string
  revision: string
}
export interface FlowPackage extends Revision {
  files: FlowFiles
}
export interface FlowConfig {
  executor: 'local-pi'
  model: string
  maxConcurrent: number
}
export interface Run extends Revision {
  flow: string
  status: string
  cwd: string
  variables: Record<string, unknown>
  config: FlowConfig
  error?: string
}
export interface FlowError {
  category: string
  summary: string
}
export interface CommandResult {
  status: 'success' | 'failure'
  exitCode: number | null
  stdout: string
  stderr: string
}
export interface NodeRun {
  id: string
  runId: string
  sequence: number
  nodeName?: string
  nodeRef: string
  actionKind: string
  input: unknown
  status: string
  startedAt: string
  completedAt?: string
  outcome?: { result: string; variables?: Record<string, unknown> }
  error?: FlowError
  commandResult?: CommandResult
  childRunId?: string
  retryOf?: string
  enteredFrom: { kind: string; [key: string]: unknown }
}
export interface RouteDecision {
  id: string
  runId: string
  sequence: number
  sourceNodeRunId: string
  result: string
  destination: { kind: string; ref?: string }
  selectedAt: string
}
export interface RunRecord {
  id: string
  flowId: string
  flowVersion: string
  status: string
  phase: string
  sequence: number
  startedAt: string
  completedAt?: string
  parentRunId?: string
  error?: FlowError
  [key: string]: unknown
}
export interface ParallelRound {
  id: string
  sequence: number
  parallelRef: string
  status: string
  startedAt: string
  completedAt?: string
  branchStatuses: Record<string, string>
  error?: FlowError
}
export interface RunRecovery {
  id: string
  sequence: number
  strategy: string
  resumedAt: string
  summary: string
}
export interface RunHistory {
  job: Run
  runs: RunRecord[]
  nodeRuns: NodeRun[]
  routeDecisions: RouteDecision[]
  parallelRounds: ParallelRound[]
  recoveries: RunRecovery[]
  [key: string]: unknown
}
export interface ConsoleConfig {
  mode: 'demo' | 'live'
  auth?: boolean
  apiBase?: string
  workspace?: { name: string; path: string }
}
export interface Source {
  mode: 'demo' | 'live'
  auth: boolean
  workspace?: { name: string; path: string }
  flows(signal?: AbortSignal): Promise<string[]>
  flow(id: string, signal?: AbortSignal): Promise<FlowPackage>
  create(id: string, files: FlowFiles): Promise<Revision>
  validate(id: string, files: FlowFiles): Promise<{ id: string; valid: boolean }>
  update(id: string, files: FlowFiles, expectedRevision?: string): Promise<Revision>
  remove(id: string): Promise<Revision>
  start(id: string, variables: Record<string, unknown>, runId?: string): Promise<Run>
  runs(signal?: AbortSignal): Promise<Run[]>
  run(id: string, signal?: AbortSignal): Promise<Run>
  history(id: string, signal?: AbortSignal): Promise<RunHistory>
  stop(id: string): Promise<Run>
  config(signal?: AbortSignal): Promise<FlowConfig>
  configure(patch: Partial<FlowConfig>): Promise<FlowConfig>
}

const tokenKey = 'ursi-flow:bearer'
const sessionKey = 'ursi-flow:session'
export const readToken = () => {
  try {
    return sessionStorage.getItem(tokenKey) || ''
  } catch {
    return ''
  }
}
export const setToken = (value: string) => {
  try {
    if (value.trim()) sessionStorage.setItem(tokenKey, value.trim())
    else sessionStorage.removeItem(tokenKey)
  } catch {
    /* 存储受限时仍允许本次输入生效。 */
  }
  window.dispatchEvent(new Event(sessionKey))
}
export const subscribeSession = (notify: () => void) => {
  window.addEventListener(sessionKey, notify)
  return () => window.removeEventListener(sessionKey, notify)
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}
const fallback: Record<number, string> = {
  401: '访问令牌无效或已过期',
  404: '资源不存在',
  409: '目录修订已变化，请重新载入后再保存',
  413: '请求内容过大',
  429: 'Runtime 正忙，请稍后重试',
  503: 'Runtime 未启动或连接失败',
  504: 'Runtime 响应超时',
}

function createClient(apiBase: string): Source {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const token = readToken()
    const headers = new Headers(init?.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    let body: string | undefined
    if (init?.body != null) {
      headers.set('Content-Type', 'application/json')
      body = init.body as string
    }
    const response = await fetch(apiBase + path, {
      ...init,
      body,
      headers,
      signal: init?.signal,
      cache: 'no-store',
      redirect: 'error',
    })
    if (!response.ok) {
      if (response.status === 401 && readToken() === token) setToken('')
      const result = await response.json().catch(() => null)
      const detail = result?.error?.message
      throw new ApiError(
        response.status,
        result?.error?.code || '',
        typeof detail === 'string' && detail
          ? detail
          : fallback[response.status] || `请求失败（HTTP ${response.status}）`,
      )
    }
    return response.json() as Promise<T>
  }
  const send = <T>(method: string, path: string, payload?: unknown) =>
    request<T>(path, {
      method,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
  const flowPath = (id: string) => `/flows/${encodeURIComponent(id)}`
  const runPath = (id: string) => `/runs/${encodeURIComponent(id)}`
  return {
    mode: 'live',
    auth: true,
    flows: (signal) => request('/flows', { signal }),
    flow: (id, signal) => request(flowPath(id), { signal }),
    create: (id, files) => send('POST', '/flows', { id, files }),
    validate: (id, files) => send('POST', '/flows/validate', { id, files }),
    update: (id, files, expectedRevision) =>
      send('PUT', flowPath(id), { files, expectedRevision }),
    remove: (id) => send('DELETE', flowPath(id)),
    start: (id, variables, runId) =>
      send('POST', `${flowPath(id)}/runs`, { runId, workspace: 'default', variables }),
    runs: (signal) => request('/runs', { signal }),
    run: (id, signal) => request(runPath(id), { signal }),
    history: (id, signal) => request(`${runPath(id)}/history`, { signal }),
    stop: (id) => send('POST', `${runPath(id)}/stop`),
    config: (signal) => request('/flow-config', { signal }),
    configure: (patch) => send('PATCH', '/flow-config', patch),
  }
}

export async function loadSource(signal?: AbortSignal): Promise<Source> {
  const response = await fetch('./console-config.json', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error('无法读取控制台配置')
  const config = (await response.json()) as ConsoleConfig
  if (config.mode === 'demo') return (await import('./demo')).demoSource
  if (config.mode !== 'live') throw new Error('控制台配置无效')
  const source = createClient(config.apiBase || '/api/v1')
  source.auth = config.auth !== false
  source.workspace = config.workspace
  return source
}
