// 数据层：与 workbench 的 /api/v1 契约一致，实时模式由同源 server.mjs 转发到 ursi-flowd。
export type FlowFiles = Record<string, string>
export interface Revision {
  id: string
  revision: string
}
export interface FlowPackage extends Revision {
  files: FlowFiles
}
/** 模型接入配置：密钥只回传是否已配置，页面不保存明文。 */
export interface ProviderConfig {
  baseUrl: string
  model: string
  api?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  thinkingLevel?: string
  apiKeySet?: boolean
}
export interface FlowConfig {
  executor: 'local-pi'
  provider: ProviderConfig
  maxConcurrent: number
}
/** PATCH 只提交变化的部分；apiKey 留空表示沿用已保存的密钥。 */
export interface ConfigPatch {
  provider?: Partial<Omit<ProviderConfig, 'apiKeySet'>> & { apiKey?: string }
  maxConcurrent?: number
}
export const PROVIDER_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const

/** provider 缺项时返回缺的字段，页面据此提示去补配置。 */
export function providerMissing(config?: FlowConfig | null): string[] {
  const provider = config?.provider
  if (!provider) return ['baseUrl', 'apiKey', 'model']
  const missing: string[] = []
  if (!provider.baseUrl?.trim()) missing.push('baseUrl')
  if (!provider.apiKeySet) missing.push('apiKey')
  if (!provider.model?.trim()) missing.push('model')
  return missing
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
  /** Pi 会话引用：Agent 节点执行记录用它定位轨迹切片。 */
  session?: { id: string; sessionReference?: string }
}
export interface RouteDecision {
  id: string
  runId: string
  sequence: number
  sourceNodeRunId: string
  result: string
  destination: { kind: 'node' | 'parallel'; ref: string } | { kind: 'finish' }
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
  /** 分支引用名 → 该轮分支的节点执行 ID，用于在流转图上标记实际的并行分支。 */
  branchNodeRunIds?: Record<string, string>
  joinNodeRunId?: string
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
/** 一次 Agent 节点执行的 Pi 会话 JSONL 切片。 */
export interface NodeTrajectory {
  node: string
  size: number
  jsonl: string
  omitted?: boolean
}
export interface ConsoleConfig {
  mode: 'demo' | 'live'
  apiBase?: string
  workspace?: { name: string; path: string }
}
export interface Source {
  mode: 'demo' | 'live'
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
  /** 运行启动时固定的 Flow 修订；详情页据此绘制流转图。 */
  runFlow(id: string, signal?: AbortSignal): Promise<FlowPackage>
  trajectory(id: string, node: string, signal?: AbortSignal): Promise<NodeTrajectory>
  stop(id: string): Promise<Run>
  config(signal?: AbortSignal): Promise<FlowConfig>
  configure(patch: ConfigPatch): Promise<FlowConfig>
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
    const headers = new Headers(init?.headers)
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
    runFlow: (id, signal) => request(`${runPath(id)}/flow`, { signal }),
    trajectory: (id, node, signal) =>
      request(`${runPath(id)}/nodes/${encodeURIComponent(node)}/trajectory`, { signal }),
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
  source.workspace = config.workspace
  return source
}
