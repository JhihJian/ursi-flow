/** flow-web API 客户端：路径与形状同 apps/flow-web/server/src/api.ts 一一对应。 */

export type FlowValue = string | number | boolean | null | FlowValue[] | { [key: string]: FlowValue }
export type FlowVariables = Record<string, FlowValue>

export interface FlowVariableView {
  name: string
  description: string
  required: boolean
  default?: FlowValue
}

export interface FlowOutcomeView {
  name: string
  description: string
  destination: { kind: 'node' | 'parallel' | 'finish'; ref?: string; name?: string }
}

export interface FlowNodeView {
  ref: string
  name: string
  kind: 'agent' | 'confirm' | 'command'
  prompt?: string
  request?: { command?: string; args?: string[]; output?: string; cwd?: string }
  outcomes: FlowOutcomeView[]
}

export interface FlowParallelView {
  ref: string
  branches: string[]
  joinRef: string
  joinName: string
}

export interface FlowSummary {
  id: string
  dir: string
  name: string
  description: string
  nodeCount: number
  variableCount: number
  valid: boolean
  error?: string
}

export interface FlowDetail extends FlowSummary {
  path: string
  variables: FlowVariableView[]
  nodes: FlowNodeView[]
  parallels: FlowParallelView[]
}

export type RunStatus =
  | 'running'
  | 'awaiting_input'
  | 'completed'
  | 'failed'
  | 'unconfirmed'
  | 'interrupted'

export interface ExecutorOption {
  id: string
  title: string
  description: string
}

export interface RunSummary {
  runId: string
  flowId: string
  /** 这次运行使用的执行器标识。 */
  executor: string
  status: RunStatus
  startedAt: string
  updatedAt: string
  stepCount: number
  failure?: { code: string; message: string }
}

export interface PendingConfirm {
  stepId: string
  nodeRef: string
  nodeName: string
  message: string
  options: string[]
}

export interface CompletedStep {
  stepId: string
  nodeRef: string
  result: { outcome: string; variables?: FlowVariables }
}

export interface LogEvent {
  type: string
  seq: number
  at: string
  nodeName?: string
  nodeRef?: string
  stepId?: string
  prompt?: string
  outcome?: string
  result?: string
  reason?: string
  exitCode?: number
  message?: string
  code?: string
  variables?: FlowVariables
  options?: string[]
  destination?: { kind: string; ref?: string }
  fromStatus?: string
}

export interface RunView extends RunSummary {
  flowPath?: string
  cwd?: string
  variables: FlowVariables
  steps: CompletedStep[]
  pending?: PendingConfirm
  events: LogEvent[]
  active: boolean
}

export interface FlowConfig {
  flowHome: string
  stateDir: string
  runsRoot: string
  /** 可选的执行器清单；新增适配器后这里自动多一项。 */
  executors: ExecutorOption[]
  defaultExecutor: string
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export interface FlowClient {
  getConfig(): Promise<FlowConfig>
  setFlowHome(flowHome: string): Promise<FlowConfig>
  listFlows(): Promise<{ flowHome: string; flows: FlowSummary[] }>
  getFlow(id: string): Promise<FlowDetail>
  listRuns(): Promise<RunSummary[]>
  startRun(input: {
    flowId: string
    variables: FlowVariables
    executor?: string
  }): Promise<{ runId: string }>
  getRun(runId: string): Promise<RunView>
  confirm(runId: string, stepId: string, result: string): Promise<RunView>
  resume(runId: string): Promise<RunView>
  stopRun(runId: string, reason?: string): Promise<RunView>
}

/** apiBaseUrl 由宿主注入，模块内不硬编码前缀。 */
export function createFlowClient(apiBaseUrl: string): FlowClient {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null
      throw new ApiError(
        body?.error?.message ?? `请求失败：${response.status}`,
        response.status,
      )
    }
    return (await response.json()) as T
  }

  return {
    getConfig: () => request('/config'),
    setFlowHome: (flowHome) =>
      request('/config', { method: 'PUT', body: JSON.stringify({ flowHome }) }),
    listFlows: () => request('/flows'),
    getFlow: async (id) =>
      (await request<{ flow: FlowDetail }>(`/flows/${encodeURIComponent(id)}`)).flow,
    listRuns: async () => (await request<{ runs: RunSummary[] }>('/runs')).runs,
    startRun: (input) =>
      request('/runs', { method: 'POST', body: JSON.stringify(input) }),
    getRun: async (runId) =>
      (await request<{ run: RunView }>(`/runs/${encodeURIComponent(runId)}`)).run,
    confirm: async (runId, stepId, result) =>
      (
        await request<{ run: RunView }>(
          `/runs/${encodeURIComponent(runId)}/confirm`,
          { method: 'POST', body: JSON.stringify({ stepId, result }) },
        )
      ).run,
    resume: async (runId) =>
      (
        await request<{ run: RunView }>(
          `/runs/${encodeURIComponent(runId)}/resume`,
          { method: 'POST', body: '{}' },
        )
      ).run,
    stopRun: async (runId, reason) =>
      (
        await request<{ run: RunView }>(
          `/runs/${encodeURIComponent(runId)}/stop`,
          { method: 'POST', body: JSON.stringify({ reason }) },
        )
      ).run,
  }
}
